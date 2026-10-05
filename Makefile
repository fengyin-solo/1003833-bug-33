.PHONY: install frontend build verify-pottery

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

verify-pottery:
	cd frontend && ./node_modules/.bin/esbuild ../scripts/verify-pottery.ts \
		--bundle --platform=node --format=cjs --outfile=/tmp/verify-pottery.cjs --log-level=warning
	node /tmp/verify-pottery.cjs
