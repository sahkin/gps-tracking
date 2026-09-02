'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LngLat } from '@/lib/geo'

export type GpsFix = {
  lngLat: LngLat
  accuracy: number
  altitude: number | null
  heading: number | null
  speed: number | null
  timestamp: number
}

export type GpsStatus = 'idle' | 'locating' | 'tracking' | 'error' | 'unsupported'

const OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }

function toFix(p: GeolocationPosition): GpsFix {
  return {
    lngLat: [p.coords.longitude, p.coords.latitude],
    accuracy: p.coords.accuracy,
    altitude: p.coords.altitude,
    heading: p.coords.heading,
    speed: p.coords.speed,
    timestamp: p.timestamp,
  }
}

function describeError(e: GeolocationPositionError): string {
  switch (e.code) {
    case e.PERMISSION_DENIED:
      return 'Location permission denied. Enable it in your browser settings.'
    case e.POSITION_UNAVAILABLE:
      return 'Position unavailable. Check GPS or network.'
    case e.TIMEOUT:
      return 'GPS timed out. Move to open sky and retry.'
    default:
      return 'Unknown geolocation error.'
  }
}

export function useGeolocation() {
  const [fix, setFix] = useState<GpsFix | null>(null)
  const [status, setStatus] = useState<GpsStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const watchId = useRef<number | null>(null)

  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator

  const locate = useCallback((): Promise<GpsFix> => {
    return new Promise((resolve, reject) => {
      if (!supported) {
        setStatus('unsupported')
        const msg = 'Geolocation is not supported by this browser.'
        setError(msg)
        reject(new Error(msg))
        return
      }
      setStatus('locating')
      setError(null)
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const f = toFix(p)
          setFix(f)
          setStatus((s) => (s === 'tracking' ? s : 'idle'))
          resolve(f)
        },
        (e) => {
          const msg = describeError(e)
          setError(msg)
          setStatus('error')
          reject(new Error(msg))
        },
        OPTIONS,
      )
    })
  }, [supported])

  const startTracking = useCallback(() => {
    if (!supported || watchId.current !== null) return
    setStatus('tracking')
    setError(null)
    watchId.current = navigator.geolocation.watchPosition(
      (p) => setFix(toFix(p)),
      (e) => {
        setError(describeError(e))
        setStatus('error')
      },
      OPTIONS,
    )
  }, [supported])

  const stopTracking = useCallback(() => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current)
      watchId.current = null
    }
    setStatus('idle')
  }, [])

  useEffect(() => () => stopTracking(), [stopTracking])

  return { fix, status, error, supported, locate, startTracking, stopTracking, tracking: status === 'tracking' }
}
