import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import zh from './locales/zh.json'

const LANGUAGE_KEY = 'imai.language'

function getInitialLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY)
    if (saved === 'en' || saved === 'zh') return saved
  } catch {}
  return 'zh'
}

i18next.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
})

export default i18next
