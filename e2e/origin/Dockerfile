FROM node:24-bookworm

RUN mkdir /certs && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=origin \
	-keyout /certs/key.pem -out /certs/cert.pem
COPY server.mjs /server.mjs

EXPOSE 443
CMD ["node", "/server.mjs"]
