# The image the development stack and the local checks run in.
#
# It carries Node, pnpm and the workspace's dependencies; the source is bind-mounted at run
# time so an edit on the host is seen by the watcher without rebuilding anything. That is
# also why it installs nothing: `pnpm install` on the host is what provides the dependency
# tree, and a container that installed its own copy would be the copy the editor does not
# see.
FROM node:22-slim

RUN npm install --global pnpm@10.34.9

ENV NODE_ENV=development
WORKDIR /app

# 3000 api, 5173 web, 9229/9230 node inspectors
EXPOSE 3000 5173 9229 9230

CMD ["pnpm", "--version"]
