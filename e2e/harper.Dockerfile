ARG HARPER_IMAGE=harperfast/harper:5.3.2
FROM ${HARPER_IMAGE}

COPY --chown=harperdb:harperdb app/ /home/harperdb/app/
RUN cd /home/harperdb/app && npm install --omit=dev --no-audit --no-fund --no-package-lock

CMD ["run", "/home/harperdb/app"]
