# ---------------------------------------------------------------------------
# 统一文本抽取：md / txt / pdf / docx 一条通路
#
# 为什么单独成模块（v2.3）：
#   1. 建库（批量扫目录）原来只认 .md，上传通路却支持 pdf/docx，两套逻辑两套坑；
#   2. 扫描版 PDF 抽出来是空文本，旧逻辑静默跳过——库里看着有文件，实际一个字没进；
#   3. 空抽取必须能"说出来"：返回 needs_ocr / note，路由层再决定报错还是告警。
#
# OCR 策略：默认不开（settings.ocr_model 为空）。开启后对"无文字层的页"渲染成图，
# 交给视觉模型转文字——比装 PaddleOCR/Tesseract 省事，代价是按页计费，故设页数上限。
# ---------------------------------------------------------------------------
from __future__ import annotations

import base64
import io
import os
import re
from dataclasses import dataclass, field

from app.config import settings

# 可入库的文本类格式（.xlsx/.pptx 暂不支持：表格与版式需要单独切块策略）
SUPPORTED_EXTS = {".md", ".txt", ".pdf", ".docx"}

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


def extract_bytes(data: bytes, filename: str) -> ExtractResult:
    """核心入口：字节流 + 文件名 → 抽取结果。异常只记在 errors 里。"""
    ext = os.path.splitext(filename or "")[1].lower()
    result = ExtractResult()
    if ext not in SUPPORTED_EXTS:
        result.note = f"不支持的格式 {ext or '(无扩展名)'}"
        return result

    try:
        if ext == ".pdf":
            _extract_pdf(data, result)
        elif ext == ".docx":
            _extract_docx(data, result)
        else:
            result.text = _decode_bytes(data)
            result.pages = 1
            result.engine = "text"
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
