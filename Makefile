# Pufferfish OpenClaw Channel Plugin Makefile

.PHONY: install build dev test clean install-plugin uninstall-plugin

# 安装依赖
install:
	npm install

# 构建
build:
	npm run build

# 开发模式（监听文件变化）
dev:
	npm run dev

# 运行测试
test:
	npm test

# 清理构建产物
clean:
	rm -rf dist node_modules

# 安装到 OpenClaw：使用 --link 链到本仓库，改代码 build 后无需反复拷贝。
# 若曾用「复制安装」且报错 plugin already exists，先执行一次:
#   rm -rf ~/.openclaw/extensions/pufferfish-channel
#
# 若报错 channels.pufferfish: unknown channel id，说明 CLI 在校验时尚未登记本插件：
# 先执行 install-plugin-openclaw（会备份配置、临时去掉 channels.pufferfish 再 install），
# 装好后把备份里的 pufferfish 段合并回 ~/.openclaw/openclaw.json。
install-plugin: build
	openclaw plugins install . --link

install-plugin-openclaw: build
	chmod +x scripts/install-openclaw-plugin.sh
	./scripts/install-openclaw-plugin.sh

# 按 package 名卸载；若本地 install 登记的 id 不同会报 not found，请先: openclaw plugins list
# 行首 - 表示找不到插件时仍返回成功，避免误伤 make reinstall
uninstall-plugin:
	-openclaw plugins uninstall @pufferfish/openclaw-channel

# 重新安装：只 build + install，不依赖 uninstall（避免 id 不一致导致失败）
reinstall: build install-plugin

# 查看插件状态
status:
	openclaw plugins list | grep pufferfish
