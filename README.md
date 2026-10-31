# YouTube Watch Later Quick Actions

Минимальное Chrome MV3-расширение для `https://www.youtube.com/playlist?list=WL`.

## Установка

1. Откройте `chrome://extensions`.
2. Включите `Developer mode`.
3. Нажмите `Load unpacked`.
4. Выберите эту папку: `youtube-watch-later-quick-actions`.

## Что добавляет

- Иконка цепочки копирует `https://youtu.be/<videoId>`.
- Иконка корзины нажимает штатный пункт удаления YouTube, проверяя, что он относится к выбранному видео в Watch Later.
- Цвет иконок берётся из текущей темы YouTube.

После обновления файлов нажмите перезагрузку расширения в `chrome://extensions` и обновите вкладку YouTube. Проверка логики: `node --test content.test.cjs`.
