# YouTube Watch Later Quick Actions

Минимальное Chrome MV3-расширение для `https://www.youtube.com/playlist?list=WL`.

## Установка

1. Откройте `chrome://extensions`.
2. Включите `Developer mode`.
3. Нажмите `Load unpacked`.
4. Выберите эту папку: `youtube-watch-later-quick-actions`.

## Что добавляет

- Иконка цепочки копирует `https://youtu.be/<videoId>`.
- Иконка корзины вызывает настоящий YouTube `serviceEndpoint` из штатного пункта `Remove from Watch later`.
- Цвет иконок берётся из текущей темы YouTube.

## Версия

- `1.0.6`: endpoint удаления теперь фильтруется по `setVideoId` текущей строки, чтобы не брать stale endpoint из старого popup.
- `1.0.5`: после удаления явно обновляет кнопки на новых строках; observer больше не зависит от `requestAnimationFrame`.
- `1.0.4`: удаление идёт через `ytd-app.resolveCommand(serviceEndpoint)`; локальное `row.remove()` и ручной `fetch` удалены.
- `1.0.3`: SVG-иконки создаются через DOM API, без `innerHTML`, чтобы не ломаться на YouTube Trusted Types.
- `1.0.2`: content script запускается в `MAIN` world, чтобы видеть `window.ytcfg` и `row.data` YouTube.
