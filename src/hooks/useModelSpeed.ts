import { useSyncExternalStore } from 'react'
import {
  getSpeedRevision,
  getSpeedSample,
  subscribeSpeed,
  type SpeedSample,
} from '../utils/speed.js'

/**
 * The most recent throughput sample for a model, kept live by subscribing to
 * the recorder. The sample is written when a response's `message_delta`
 * arrives, which can happen without the assistant message id changing, so a
 * component that only re-renders on message changes would show the previous
 * figure.
 */
export function useModelSpeed(model: string): SpeedSample | null {
  useSyncExternalStore(subscribeSpeed, getSpeedRevision, getSpeedRevision)
  return getSpeedSample(model)
}
