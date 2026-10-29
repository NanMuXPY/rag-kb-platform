# v2 后端镜像（构建上下文 = 项目根，compose 中指定）
# python:3.12-slim + 阿里源（v1 实测：清华源对服务器 403）
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_DEFAULT_TIMEOUT=120

WORKDIR /app/backend

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 内置语料打进镜像（30 篇 md，很小）；自传文档走 uploads 卷
COPY backend/app ./app
COPY backend/api ./api
COPY data ./data

EXPOSE 14052

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:14052/health')" || exit 1

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "14052"]
