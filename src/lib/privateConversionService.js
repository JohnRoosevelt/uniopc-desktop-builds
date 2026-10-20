import { callPluginsFunction } from './pluginsBackend.js'

export function createPrivateConversionService(request = callPluginsFunction) {
  return {
    callPrivateConversion(action, payload = {}) {
      return request('private-conversion', { action, payload })
    },
    callMedia(action, payload = {}) {
      return request('media', { action, payload })
    },
    callMontage(action, payload = {}) {
      return request('montage', { action, payload })
    },
    callSocials(action, payload = {}) {
      return request('socials', { action, payload })
    },
    callSuperIp(action, payload = {}) {
      return request('super-ip', { action, payload })
    },
    callAudioUnderstanding(action, payload = {}) {
      return request('audio-understanding', { action, ...payload })
    },
    callVideoToAudio(action, payload = {}) {
      return request('video-to-audio', { action, ...payload })
    },
    callVideoUnderstanding(action, payload = {}) {
      return request('video-understanding', { action, ...payload })
    },
  }
}

const service = createPrivateConversionService()

export const callPrivateConversion = service.callPrivateConversion
export const callMedia = service.callMedia
export const callMontage = service.callMontage
export const callSocials = service.callSocials
export const callSuperIp = service.callSuperIp
export const callAudioUnderstanding = service.callAudioUnderstanding
export const callVideoToAudio = service.callVideoToAudio
export const callVideoUnderstanding = service.callVideoUnderstanding
