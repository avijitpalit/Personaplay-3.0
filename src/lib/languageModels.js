export const LANGUAGE_MODELS = [
  {
    id: 'venice-uncensored',
    label: 'Venice Uncensored',
    provider: 'Venice',
    description: 'The current roleplay model. Steady prose, strong scene continuity, and the established voice.'
  },
  {
    id: 'glm-5-3-flash-uncensored',
    label: 'GLM 5.3 Flash Uncensored',
    provider: 'Venice',
    description: 'A faster uncensored model with a looser, more impulsive voice. Applies to the next story or reply.'
  },
  {
    id: 'gemma-4-uncensored',
    label: 'Gemma 4 Uncensored',
    provider: 'Venice',
    description: 'An uncensored Gemma model with a direct, grounded voice. Applies to the next story or reply.'
  },
  {
    id: 'venice-uncensored-role-play',
    label: 'Venice Uncensored Role Play',
    provider: 'Venice',
    description: 'Venice tuned for roleplay and scene momentum. Applies to the next story or reply.'
  }
];

export const DEFAULT_LANGUAGE_MODEL = LANGUAGE_MODELS[0].id;
const STORAGE_KEY = 'personaplay.language-model.v1';

export function getLanguageModel(id) {
  return LANGUAGE_MODELS.find((model) => model.id === id) || LANGUAGE_MODELS[0];
}

export function loadLanguageModel() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return LANGUAGE_MODELS.some((model) => model.id === stored) ? stored : DEFAULT_LANGUAGE_MODEL;
  } catch {
    return DEFAULT_LANGUAGE_MODEL;
  }
}

export function saveLanguageModel(id) {
  try {
    window.localStorage.setItem(STORAGE_KEY, getLanguageModel(id).id);
  } catch {
    // Preference persistence is best-effort.
  }
}
