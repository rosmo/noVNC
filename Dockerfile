FROM python:3.9-slim

RUN mkdir /noVNC
WORKDIR /noVNC

RUN apt-get update && apt-get upgrade && apt-get install -y procps

COPY vnc.html vnc.html
COPY vnc_lite.html vnc_lite.html
COPY LICENSE.txt LICENSE.txt
COPY app/ app/
COPY core/ core/
COPY po/ po/
COPY vendor/ vendor/
COPY utils/ utils/

RUN pip3 install websockify

EXPOSE 6080
ENTRYPOINT ["/bin/bash", "/noVNC/utils/novnc_proxy"]
CMD ["--help"]