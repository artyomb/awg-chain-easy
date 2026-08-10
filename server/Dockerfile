ARG AWG_IMAGE=amneziavpn/amneziawg-go:3.0.20260805

FROM golang:1.24-alpine3.21 AS wireguard-go-build

ARG WIREGUARD_GO_COMMIT=f333402bd9cbe0f3eeb02507bd14e23d7d639280
RUN apk add --no-cache git make \
    && git clone https://git.zx2c4.com/wireguard-go /src/wireguard-go \
    && git -C /src/wireguard-go checkout "$WIREGUARD_GO_COMMIT" \
    && make -C /src/wireguard-go

FROM ${AWG_IMAGE}

RUN apk add --no-cache nodejs apache2-utils libqrencode-tools nftables wireguard-tools
COPY --from=wireguard-go-build /src/wireguard-go/wireguard-go /usr/local/bin/wireguard-go

WORKDIR /app
COPY app/ ./
COPY entrypoint.sh /usr/local/bin/awg-chain-easy-entrypoint
RUN chmod 0755 /usr/local/bin/awg-chain-easy-entrypoint

ENTRYPOINT ["/usr/local/bin/awg-chain-easy-entrypoint"]
