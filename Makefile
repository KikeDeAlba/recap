PREFIX_APP ?= $(HOME)/Applications
PREFIX_BIN ?= $(HOME)/.local/bin

.PHONY: build test bundle release install uninstall clean

build:
	swift build

test:
	swift test

bundle:
	./scripts/bundle.sh

release:
	./scripts/release.sh

install: bundle
	mkdir -p "$(PREFIX_APP)" "$(PREFIX_BIN)"
	rm -rf "$(PREFIX_APP)/Recap.app"
	cp -R build/Recap.app "$(PREFIX_APP)/Recap.app"
	ln -sf "$(PREFIX_APP)/Recap.app/Contents/MacOS/recap" "$(PREFIX_BIN)/recap"
	@echo "Installed $(PREFIX_APP)/Recap.app and $(PREFIX_BIN)/recap"

uninstall:
	rm -rf "$(PREFIX_APP)/Recap.app" "$(PREFIX_BIN)/recap"

clean:
	rm -rf .build build
