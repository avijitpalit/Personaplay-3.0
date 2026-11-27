export const IMAGE_MODELS = [
  {
    id: 'modal-z-image-turbo',
    label: 'Z-Image-Turbo · Modal',
    provider: 'Modal',
    description: 'The current fast endpoint. 9-step photoreal render at 720×1280.'
  },
  {
    id: 'runpod-z-image-turbo',
    label: 'Z-Image-Turbo · RunPod',
    provider: 'RunPod',
    description: 'Alternate serverless endpoint with the same Z-Image-Turbo model. Queued jobs can take longer.'
  },
  {
    id: 'venice-z-image-turbo',
    label: 'Z-Image-Turbo · Venice AI',
    provider: 'Venice',
    description: 'Venice-hosted Z-Image-Turbo. Venice returns a portrait frame that is cropped to the app’s exact 9:16 720×1280 output.'
  }
];

export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].id;
const STORAGE_KEY = 'personaplay.image-model.v1';

export function getImageModel(id) {
  return IMAGE_MODELS.find((model) => model.id === id) || IMAGE_MODELS[0];
}

export function loadImageModel() {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return IMAGE_MODELS.some((model) => model.id === stored) ? stored : DEFAULT_IMAGE_MODEL;
  } catch {
    return DEFAULT_IMAGE_MODEL;
  }
}

export function saveImageModel(id) {
  try {
    window.localStorage.setItem(STORAGE_KEY, getImageModel(id).id);
  } catch {
    // Preference persistence is best-effort.
  }
}
