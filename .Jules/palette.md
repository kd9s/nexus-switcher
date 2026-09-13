## 2024-05-14 - Localized ARIA Labels
**Learning:** The application's custom i18n implementation (`applyTranslations` in `app.js`) lacked native support for localizing `aria-label` attributes. Without this, icon-only buttons could not be properly labeled for screen readers across different languages.
**Action:** Added `data-i18n-aria-label` attribute processing to the core localization loop. This provides a reusable, scalable UX pattern for the entire design system to ensure accessible labels stay in sync with the current UI language.
