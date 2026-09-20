FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /opt/runner

RUN apt-get update \
    && apt-get install --yes --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py resource_wrapper.py ./

EXPOSE 8080

CMD ["python", "/opt/runner/server.py"]
