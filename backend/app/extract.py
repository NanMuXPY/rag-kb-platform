# ---------------------------------------------------------------------------
# 统一文本抽取：md / txt / pdf / docx / xlsx / pptx 一条通路
#
# 为什么单独成模块（v2.3）：
#   1. 建库（批量扫目录）原来只认 .md，上传通路却支持 pdf/docx，两套逻辑两套坑；
#   2. 扫描版 PDF 抽出来是空文本，旧逻辑静默跳过——库里看着有文件，实际一个字没进；
#   3. 空抽取必须能"说出来"：返回 needs_ocr / note，路由层再决定报错还是告警。
#
# OCR 策略：默认不开（settings.ocr_model 为空）。开启后对"无文字层的页"渲染成图，
# 交给视觉模型转文字——比装 PaddleOCR/Tesseract 省事，代价是按页计费，故设页数上限。
#
# v2.4 补 xlsx / pptx：
#   - 表格与幻灯片是技术支持场景最常见的"口径来源"（配额表、参数表、值班表、
#     上线步骤 PPT），只认 md/docx 等于把半个知识库挡在门外；
#   - 表格按行转成 `列名=值；列名=值`，而不是裸的 `a | b | c`：切块是 800 字符硬切，
#     一行被切走时只有带上列名才知道每个数字是什么；
#   - 公式取缓存值（data_only），没有缓存值（文件没被 Excel 打开过）时退回公式文本；
#   - 超大表按行数截断并在 note 里说明，避免一张 10 万行的导出表把库撑爆。
# ---------------------------------------------------------------------------
from __future__ import annotations

import base64
import io
import os
import re
from dataclasses import dataclass, field

from app.config import settings

# 可入库的文本类格式。.xls/.ppt 是二进制旧格式，解析库不支持，故不收（提示另存为新格式）
SUPPORTED_EXTS = {".md", ".txt", ".pdf", ".docx", ".xlsx", ".pptx"}

# 旧格式 → 新格式的提示语，报错时告诉用户该怎么办，而不是干巴巴一句"不支持"
LEGACY_HINT = {".xls": ".xlsx", ".ppt": ".pptx", ".doc": ".docx"}

# 单个工作表最多读多少行（防止有人把百万行导出报表丢进来）
SHEET_MAX_ROWS = 5000

# 中文文本常见的三种编码，按顺序试
_TEXT_ENCODINGS = ("utf-8", "gb18030", "utf-16")

# 判定"这页没文字"的阈值：去空白后少于这么多字符，就当作图片页
_PAGE_TEXT_MIN = 8


@dataclass
class ExtractResult:
    text: str = ""
    pages: int = 0
    engine: str = "text"          # text / pypdf / docx / vision-ocr
    needs_ocr: bool = False       # 有页没抽出文字，需要 OCR
    ocr_pages: int = 0            # 实际送去做 OCR 的页数
    note: str = ""
    errors: list[str] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return len(self.text)

    def as_dict(self) -> dict:
        return {
            "chars": self.chars,
            "pages": self.pages,
            "engine": self.engine,
            "needs_ocr": self.needs_ocr,
            "ocr_pages": self.ocr_pages,
            "note": self.note,
        }


def _clean(text: str) -> str:
    """统一空白：去掉多余空行与行尾空格，保留段落结构。"""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t\u3000]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _decode_bytes(data: bytes) -> str:
    """按候选编码解码，取"替换字符最少"的那个（GBK 存量文档很常见）。"""
    best, best_bad = "", None
    for enc in _TEXT_ENCODINGS:
        try:
            s = data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        bad = s.count("\ufffd")
        if best_bad is None or bad < best_bad:
            best, best_bad = s, bad
            if bad == 0:
                break
    if not best:
        best = data.decode("utf-8", errors="replace")
    return best


def _extract_pdf(data: bytes, result: ExtractResult) -> None:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    result.pages = len(reader.pages)
    pages: list[str] = []
    blank: list[int] = []
    for idx, page in enumerate(reader.pages):
        try:
            txt = page.extract_text() or ""
        except Exception as exc:                      # 单页损坏不影响整本
            txt = ""
            result.errors.append(f"第 {idx + 1} 页解析失败: {type(exc).__name__}")
        if len(re.sub(r"\s", "", txt)) < _PAGE_TEXT_MIN:
            blank.append(idx)
            pages.append("")
        else:
            pages.append(txt)

    result.engine = "pypdf"
    if blank:
        result.needs_ocr = True
        if settings.ocr_model and settings.ocr_max_pages > 0:
            filled = _ocr_pdf_pages(data, blank[: settings.ocr_max_pages], result.errors)
            for idx, txt in filled.items():
                pages[idx] = txt
            result.engine = "vision-ocr"
            result.ocr_pages = len(filled)
            missed = len(blank) - len(filled)
            result.note = (
                f"{len(blank)} 页无文字层，已 OCR {len(filled)} 页"
                + (f"，{missed} 页未成功（见 errors）" if missed > 0 else "")
            )
        else:
            result.note = (
                f"{len(blank)}/{result.pages} 页无文字层（疑似扫描件），"
                "未启用 OCR（设置 OCR_MODEL 可开启）"
            )
    result.text = "\n\n".join(p for p in pages if p.strip())


def _ocr_pdf_pages(data: bytes, page_indexes: list[int],
                   errors: list[str] | None = None) -> dict[int, str]:
    """把指定页渲染成 PNG 交给视觉模型转文字。失败写进 errors，绝不抛。"""
    if not page_indexes:
        return {}

    def _fail(msg: str) -> dict[int, str]:
        if errors is not None:
            errors.append(f"OCR: {msg}")
        return {}

    try:
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz  # 旧版 pymupdf 只有 fitz 这个名字
    except Exception:
        return _fail("未安装 pymupdf，无法渲染页面")
    try:
        from openai import OpenAI
        client = OpenAI(api_key=settings.embed_api_key, base_url=settings.embed_base_url)
        if settings.ocr_api_key:
            client = OpenAI(api_key=settings.ocr_api_key,
                            base_url=settings.ocr_base_url or settings.embed_base_url)
    except Exception as exc:
        return _fail(f"客户端初始化失败 {type(exc).__name__}: {exc}")

    out: dict[int, str] = {}
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        return _fail(f"PDF 打开失败 {type(exc).__name__}: {exc}")
    try:
        for idx in page_indexes:
            try:
                pix = doc[idx].get_pixmap(dpi=160)
                b64 = base64.b64encode(pix.tobytes("png")).decode()
                resp = client.chat.completions.create(
                    model=settings.ocr_model,
                    messages=[{"role": "user", "content": [
                        {"type": "text", "text":
                         "把这张图片里的文字原样转成纯文本，保留段落换行与表格行列，"
                         "不要总结、不要加说明。图里没有文字就返回空字符串。"},
                        {"type": "image_url", "image_url": {
                            "url": f"data:image/png;base64,{b64}"}},
                    ]}],
                    temperature=0,
                )
                txt = (resp.choices[0].message.content or "").strip()
                if txt:
                    out[idx] = txt
            except Exception as exc:
                if errors is not None:
                    errors.append(f"OCR 第 {idx + 1} 页失败 {type(exc).__name__}: {exc}")
                continue
    finally:
        doc.close()
    return out


def _extract_docx(data: bytes, result: ExtractResult) -> None:
    from docx import Document

    doc = Document(io.BytesIO(data))
    parts = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:                     # 表格按行拼成 "a | b | c"
        for row in table.rows:
            cells = [c.text.strip() for c in row.cells if c.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    result.text = "\n".join(parts)
    result.pages = 1
    result.engine = "docx"


def _cell(v) -> str:
    """单元格值 → 干净字符串：去掉 Excel 里常见的 .0 尾巴与全角空格。"""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if hasattr(v, "isoformat"):            # datetime / date
        s = v.isoformat()
        return s[:10] if len(s) >= 10 and s[10] == "T" else s
    s = str(v).replace("\u3000", " ").strip()
    return re.sub(r"\s+", " ", s)


def _extract_xlsx(data: bytes, result: ExtractResult) -> None:
    """表格 → 每个工作表一段，每行 `列名=值；列名=值`。"""
    from openpyxl import load_workbook

    def _load(**kw):
        return load_workbook(io.BytesIO(data), read_only=True, data_only=True, **kw)

    try:
        book = _load()
    except Exception as exc:
        raise RuntimeError(f"xlsx 打开失败 {type(exc).__name__}: {exc}") from exc

    parts: list[str] = []
    truncated: list[str] = []
    try:
        for sheet in book.worksheets:
            rows = []
            for row in sheet.iter_rows(values_only=True):
                rows.append([_cell(c) for c in row])
                if len(rows) >= SHEET_MAX_ROWS + 1:      # +1 是表头
                    break
            if len(rows) > SHEET_MAX_ROWS:
                rows = rows[: SHEET_MAX_ROWS + 1]
                truncated.append(sheet.title)

            # 去掉整行为空的行（Excel 里格式化残留的空行很多）
            rows = [r for r in rows if any(c for c in r)]
            if not rows:
                continue

            header = rows[0]
            has_header = sum(1 for c in header if c) >= 2      # 至少两列有名字才算表头
            lines = [f"【工作表：{sheet.title}】"]
            for r in rows[1:] if has_header else rows:
                pairs = []
                for i, val in enumerate(r):
                    if not val:
                        continue
                    name = header[i] if has_header and i < len(header) and header[i] else f"列{i + 1}"
                    pairs.append(f"{name}={val}")
                if pairs:
                    lines.append("；".join(pairs))
            if has_header:                                       # 表头本身也是一条事实
                cols = [c for c in header if c]
                lines.insert(1, "表头：" + " | ".join(cols))
            parts.append("\n".join(lines))
            result.pages += 1
    finally:
        book.close()

    # 公式没有缓存值（文件从没被 Excel/WPS 打开保存过）时，上面全是空——退回读公式文本
    if not any(parts):
        try:
            book = load_workbook(io.BytesIO(data), read_only=True, data_only=False)
            for sheet in book.worksheets:
                lines = [f"【工作表：{sheet.title}】"]
                for row in sheet.iter_rows(values_only=True):
                    cells = [f"{c}" for c in row if isinstance(c, str) and c.startswith("=")]
                    if cells:
                        lines.append("公式：" + " | ".join(cells))
                if len(lines) > 1:
                    parts.append("\n".join(lines))
            book.close()
            if parts:
                result.note = "表格只有公式没有计算结果，已按公式文本入库"
        except Exception as exc:
            result.errors.append(f"公式回读失败 {type(exc).__name__}: {exc}")

    result.text = "\n\n".join(parts)
    result.engine = "openpyxl"
    if truncated:
        result.note = (result.note + "；" if result.note else "") + \
            f"{'、'.join(truncated)} 超过 {SHEET_MAX_ROWS} 行，仅取前 {SHEET_MAX_ROWS} 行"


def _shape_texts(shape) -> list[str]:
    """递归取形状里的文字：组合形状要下钻，表格要按行拼。"""
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    out: list[str] = []
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        for sub in shape.shapes:
            out.extend(_shape_texts(sub))
        return out
    if getattr(shape, "has_table", False):
        for row in shape.table.rows:
            cells = [_cell(c.text) for c in row.cells]
            cells = [c for c in cells if c]
            if cells:
                out.append(" | ".join(cells))
        return out
    if getattr(shape, "has_text_frame", False) and shape.text_frame:
        txt = _clean(shape.text_frame.text)
        if txt:
            out.append(txt)
    return out


def _extract_pptx(data: bytes, result: ExtractResult) -> None:
    """幻灯片 → 每页一段，含表格与演讲者备注（备注里常写口径与前提）。"""
    from pptx import Presentation

    prs = Presentation(io.BytesIO(data))
    parts: list[str] = []
    for idx, slide in enumerate(prs.slides, 1):
        blocks: list[str] = []
        for shape in slide.shapes:
            blocks.extend(_shape_texts(shape))
        note = ""
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            note = _clean(slide.notes_slide.notes_text_frame.text)
            if note:
                blocks.append(f"备注：{note}")
        if blocks:
            parts.append(f"【第 {idx} 页】\n" + "\n".join(blocks))
    result.text = "\n\n".join(parts)
    result.pages = len(prs.slides)
    result.engine = "python-pptx"


def extract_bytes(data: bytes, filename: str) -> ExtractResult:
    """核心入口：字节流 + 文件名 → 抽取结果。异常只记在 errors 里。"""
    ext = os.path.splitext(filename or "")[1].lower()
    result = ExtractResult()
    if ext not in SUPPORTED_EXTS:
        hint = LEGACY_HINT.get(ext)
        result.note = (
            f"不支持 {ext} 旧格式，请用 Office/WPS 另存为 {hint} 后再上传"
            if hint else f"不支持的格式 {ext or '(无扩展名)'}，支持 {'/'.join(sorted(SUPPORTED_EXTS))}"
        )
        return result

    try:
        if ext == ".pdf":
            _extract_pdf(data, result)
        elif ext == ".docx":
            _extract_docx(data, result)
        elif ext == ".xlsx":
            _extract_xlsx(data, result)
        elif ext == ".pptx":
            _extract_pptx(data, result)
        else:
            result.text = _decode_bytes(data)
            result.pages = 1
            result.engine = "text"
    except ImportError as exc:            # 依赖没装：说清楚缺什么，别让上传直接 500
        result.errors.append(f"{type(exc).__name__}: {exc}")
        result.note = f"缺少解析 {ext} 的依赖，请在后端安装 requirements.txt"
        return result
    except Exception as exc:
        result.errors.append(f"{type(exc).__name__}: {exc}")
        result.note = "解析失败，原文可能已损坏或被加密"
        return result

    result.text = _clean(result.text)
    if not result.text and not result.note:
        result.needs_ocr = ext == ".pdf" and result.pages > 0
        result.note = "未抽出任何文字（空文件或纯图片内容）"
    return result


def extract_path(path: str | os.PathLike) -> ExtractResult:
    """按路径抽取（建库扫描与审批入库共用）。"""
    path = str(path)
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception as exc:
        r = ExtractResult()
        r.note = f"读取失败: {type(exc).__name__}: {exc}"
        return r
    return extract_bytes(data, path)
