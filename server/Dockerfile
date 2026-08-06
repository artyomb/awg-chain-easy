ARG AWG_IMAGE=amneziavpn/amneziawg-go:3.0.20260805
FROM ${AWG_IMAGE}

RUN apk add --no-cache nodejs apache2-utils libqrencode-tools nftables

WORKDIR /app
COPY app/ ./
COPY entrypoint.sh /usr/local/bin/awg-chain-easy-entrypoint
RUN chmod 0755 /usr/local/bin/awg-chain-easy-entrypoint

ENTRYPOINT ["/usr/local/bin/awg-chain-easy-entrypoint"]
