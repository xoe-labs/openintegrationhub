FROM node:12-alpine AS base
WORKDIR /usr/lib/app

RUN apk update && apk add --no-cache bash

COPY package.json yarn.lock ./
COPY lib/backend-commons-lib ./lib/backend-commons-lib
COPY lib/iam-utils ./lib/iam-utils
COPY services/logging-service/package.json services/logging-service/tsconfig.json ./services/logging-service/
COPY services/logging-service/docs ./services/logging-service/docs/

# Image for building and installing dependencies
# node-gyp is required as dependency by some npm package
# but node-gyp requires in build time python, build-essential, ....
# that's not required in runtime
FROM base AS dependencies
RUN apk update && apk add --no-cache \
    make \
    gcc \
    g++ \
    python
COPY services/logging-service ./services/logging-service
RUN cd services/logging-service && yarn install && yarn run build:ts

FROM base AS release
COPY --from=dependencies /usr/lib/app/services/logging-service/dist ./services/logging-service/dist
COPY --from=dependencies /usr/lib/app/node_modules ./node_modules
RUN rm yarn.lock

RUN chown -R node:node .
USER node

CMD ["yarn", "--cwd", "services/logging-service", "start"]
