ARG AWG_IMAGE=amneziavpn/amneziawg-go:3.1.20260828@sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72

FROM golang:1.24-alpine3.21@sha256:59a9237590705e00dd04bb43f9f75562caced1393b8767b4666a658daeb93e61 AS wireguard-go-build

ARG WIREGUARD_GO_COMMIT=f333402bd9cbe0f3eeb02507bd14e23d7d639280
RUN apk add --no-cache git make \
    && git clone https://git.zx2c4.com/wireguard-go /src/wireguard-go \
    && git -C /src/wireguard-go checkout "$WIREGUARD_GO_COMMIT" \
    && make -C /src/wireguard-go

COPY probe/main.go /src/health-probe/main.go
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /usr/local/bin/awg-chain-probe /src/health-probe/main.go

FROM ${AWG_IMAGE}
ARG AWG_IMAGE
ENV AMNEZIAWG_IMAGE=${AWG_IMAGE}

RUN apk add --no-cache nodejs apache2-utils libqrencode-tools nftables wireguard-tools ca-certificates util-linux-misc conntrack-tools
COPY --from=wireguard-go-build /src/wireguard-go/wireguard-go /usr/local/bin/wireguard-go
COPY --from=wireguard-go-build /usr/local/bin/awg-chain-probe /usr/local/bin/awg-chain-probe

WORKDIR /app
COPY app/ ./
RUN for file in ./*.js; do node --check "$file"; done \
    && node -e "require('./routing'); require('./auth')"
COPY entrypoint.sh /usr/local/bin/awg-chain-easy-entrypoint
RUN chmod 0755 /usr/local/bin/awg-chain-easy-entrypoint

ENTRYPOINT ["/usr/local/bin/awg-chain-easy-entrypoint"]
