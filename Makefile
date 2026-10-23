PREFIX_APP ?= $(HOME)/Applications
PREFIX_BIN ?= $(HOME)/.local/bin

.PHONY: build test bundle release install uninstall unlink-legacy clean

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
	ln -sf "$(PREFIX_APP)/Recap.app/Contents/MacOS/recap-capture" "$(PREFIX_BIN)/recap-capture"
	$(MAKE) unlink-legacy
	@echo "Installed $(PREFIX_APP)/Recap.app and $(PREFIX_BIN)/recap-capture"

uninstall: unlink-legacy
	rm -rf "$(PREFIX_APP)/Recap.app" "$(PREFIX_BIN)/recap-capture"

unlink-legacy:
	@if [ -L "$(PREFIX_BIN)/recap" ] && [ "$$(readlink "$(PREFIX_BIN)/recap")" = "$(PREFIX_APP)/Recap.app/Contents/MacOS/recap" ]; then rm "$(PREFIX_BIN)/recap" && echo "Removed the legacy $(PREFIX_BIN)/recap link to Recap.app"; fi

clean:
	rm -rf .build build
