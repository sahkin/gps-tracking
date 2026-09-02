'use client'

import { useState } from 'react'
import { LocateFixed, Loader2, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Position = {
  latitude: number
  longitude: number
  accuracy: number
  timestamp: number
}

type Status = 'idle' | 'loading' | 'success' | 'error'

export function CurrentLocation() {
  const [status, setStatus] = useState<Status>('idle')
  const [position, setPosition] = useState<Position | null>(null)
  const [error, setError] = useState<string | null>(null)

  function locate() {
    if (!('geolocation' in navigator)) {
      setStatus('error')
      setError('Geolocation is not supported by this browser.')
      return
    }

    setStatus('loading')
    setError(null)

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        })
        setStatus('success')
      },
      (err) => {
        const messages: Record<number, string> = {
          1: 'Permission denied. Allow location access in your browser and try again.',
          2: 'Position unavailable. Check that GPS or network location is enabled.',
          3: 'Request timed out. Please try again.',
        }
        setError(messages[err.code] ?? err.message)
        setStatus('error')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    )
  }

  return (
    <section
      aria-labelledby="location-heading"
      className="flex w-full max-w-sm flex-col gap-6 rounded-xl border border-border bg-card p-6 text-card-foreground"
    >
      <header className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <MapPin className="size-5" aria-hidden="true" />
        </span>
        <div className="flex flex-col">
          <h1 id="location-heading" className="text-lg font-semibold">
            Your location
          </h1>
          <p className="text-sm text-muted-foreground">
            Uses your device&apos;s GPS or network position
          </p>
        </div>
      </header>

      {status === 'success' && position && (
        <dl className="grid grid-cols-2 gap-4 font-mono text-sm">
          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs text-muted-foreground">Latitude</dt>
            <dd>{position.latitude.toFixed(6)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs text-muted-foreground">Longitude</dt>
            <dd>{position.longitude.toFixed(6)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs text-muted-foreground">Accuracy</dt>
            <dd>±{Math.round(position.accuracy)} m</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-sans text-xs text-muted-foreground">Updated</dt>
            <dd>{new Date(position.timestamp).toLocaleTimeString()}</dd>
          </div>
        </dl>
      )}

      {status === 'error' && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {status === 'idle' && (
        <p className="text-sm text-muted-foreground">
          Click the button below and allow location access when prompted.
        </p>
      )}

      <Button onClick={locate} disabled={status === 'loading'} className="w-full">
        {status === 'loading' ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <LocateFixed className="size-4" aria-hidden="true" />
        )}
        {status === 'loading'
          ? 'Locating…'
          : status === 'success'
            ? 'Refresh location'
            : 'Get my location'}
      </Button>

      {status === 'success' && position && (
        <a
          href={`https://www.google.com/maps?q=${position.latitude},${position.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-center text-sm text-primary underline-offset-4 hover:underline"
        >
          Open in Google Maps
        </a>
      )}
    </section>
  )
}
