# cline-account-switcher (русская версия)

Автоматически переключает аккаунты Cline, когда лимит запросов **для используемой вами модели** исчерпан, и возобновляет задачу на новом аккаунте.

Без прокси, роутера и форка Cline. Хук встраивается в собственное событие `TaskError` Cline и перезаписывает блок учётных данных, который Cline уже читает.

## Как это работает

Cline вызывает хук при каждой ошибке задачи. Проект устанавливает файл хука `TaskError` в каталог хуков Cline. Контракт ниже вычитан из установленных бандлов `@cline/core` / `@cline/shared` v3.0.62.

| Элемент | Проверенная деталь |
| --- | --- |
| Имя файла хука | `TaskError` соответствует событию `agent_error` |
| Расположение | `<clineDir>/hooks`, то есть `~/.cline/hooks` |
| Интерпретатор | `.mjs` запускается как `node <path>` (Windows) |
| Вход | JSON на stdin |
| Выход | Cline парсит весь stdout в объект управления |
| Учётные данные | `$CLINE_PROVIDER_SETTINGS_PATH` ?? `~/.cline/data/settings/providers.json` |
| Блок аккаунта | `providers.cline.settings.auth` |
| Обновление токена | Cline обновляет из refreshToken сам (буфер 5 мин) |

## Установка и запуск (выполнено)

- Node.js v22.23.4, npm 10.9.9.
- `node --test` — 28/28 тестов проходят.
- `node bin/switch.mjs init` выполнен: домашний каталог `~/.cline-account-switcher` создан.

## Регистрация аккаунтов

Для каждого аккаунта с отдельным data-dir:

```bash
CLINE_PROVIDER_SETTINGS_PATH=/path/to/account/settings/providers.json node bin/switch.mjs capture --label <name>
```

Повторите для всех аккаунтов, затем:

```bash
node bin/switch.mjs install-hook
```

## Ежедневное использование

```bash
node bin/switch.mjs status
node bin/switch.mjs use work
node bin/switch.mjs rotate
node bin/switch.mjs reset
node bin/switch.mjs serve
```

## Тесты

```bash
node --test
```

## Предостережения

- Хранение refresh token в открытом виде; обращайтесь как с SSH-ключом.
- `run` требует найти `cline` (CLINE_BIN).
## Автозапуск дашборда при старте macOS

Создан LaunchAgent `~/Library/LaunchAgents/com.cline.switcher.serve.plist`, который запускает `node bin/switch.mjs serve --no-open` при входе в систему и перезапускает при падении.

Управление:
- Остановить: `launchctl unload ~/Library/LaunchAgents/com.cline.switcher.serve.plist`
- Запустить: `launchctl load ~/Library/LaunchAgents/com.cline.switcher.serve.plist`
- Логи: `~/.cline-account-switcher/serve.out.log` и `serve.err.log`

