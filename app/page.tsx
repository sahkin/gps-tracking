import { CurrentLocation } from '@/components/current-location'

export default function Page() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <CurrentLocation />
    </main>
  )
}
