import { useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  CircleSlash2,
  CircleX,
  LoaderCircle,
  Plus,
  ScanSearch,
  ShieldCheck,
  X,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  cancelBrowserDiscovery,
  discoverBrowserAccounts,
  listBrowserProfiles,
  type BrowserAccountDiscovery,
  type BrowserAccountProviderId,
  type BrowserName,
  type BrowserProfile,
} from "@/lib/browser-accounts"
import type { ProviderAccountOperationReceipt } from "@/lib/plugin-types"

type BrowserAccountManagerProps = {
  busy: boolean
  providerId?: BrowserAccountProviderId
  onAttach: (candidateId: string) => Promise<ProviderAccountOperationReceipt | null>
}

const ALL_PROFILES = "all"

type BrowserAccountUiError = {
  title: "Browser Profiles Unavailable" | "Browser Discovery Error"
  code: string
  message: string
}

function typedError(
  cause: unknown,
  title: BrowserAccountUiError["title"],
  fallbackMessage: string
): BrowserAccountUiError {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    typeof cause.code === "string" &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return { title, code: cause.code, message: cause.message }
  }
  return { title, code: "unknown", message: fallbackMessage }
}

export function BrowserAccountManager({
  busy,
  providerId = "cursor",
  onAttach,
}: BrowserAccountManagerProps) {
  const mounted = useRef(true)
  const activeRequestId = useRef<string | null>(null)
  const [open, setOpen] = useState(false)
  const [browser, setBrowser] = useState<BrowserName | null>(null)
  const [profiles, setProfiles] = useState<BrowserProfile[]>([])
  const [profilesListed, setProfilesListed] = useState(false)
  const [loadingProfiles, setLoadingProfiles] = useState(false)
  const [profileKey, setProfileKey] = useState("")
  const [discovery, setDiscovery] = useState<BrowserAccountDiscovery | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<BrowserAccountUiError | null>(null)

  function cancelRequest(requestId: string) {
    void cancelBrowserDiscovery(requestId).catch(() => {
      console.error("Failed to cancel browser account discovery")
    })
  }

  function closeManager() {
    const requestId = activeRequestId.current
    activeRequestId.current = null
    if (requestId) cancelRequest(requestId)
    setOpen(false)
    setBrowser(null)
    setProfiles([])
    setProfilesListed(false)
    setLoadingProfiles(false)
    setProfileKey("")
    setDiscovery(null)
    setScanning(false)
    setError(null)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const requestId = activeRequestId.current
      activeRequestId.current = null
      if (requestId) cancelRequest(requestId)
    }
  }, [])

  async function chooseBrowser(nextBrowser: BrowserName) {
    const requestId = activeRequestId.current
    activeRequestId.current = null
    if (requestId) cancelRequest(requestId)
    setBrowser(nextBrowser)
    setProfiles([])
    setProfilesListed(false)
    setProfileKey("")
    setDiscovery(null)
    setScanning(false)
    setError(null)
    setLoadingProfiles(true)
    try {
      const response = await listBrowserProfiles(nextBrowser)
      if (mounted.current) {
        setProfiles(response.profiles)
        setProfilesListed(true)
      }
    } catch (cause) {
      const nextError = typedError(
        cause,
        "Browser Profiles Unavailable",
        "Browser profiles could not be listed. Try another browser."
      )
      console.error("Failed to list browser profiles", nextError.code)
      if (mounted.current) setError(nextError)
    } finally {
      if (mounted.current) setLoadingProfiles(false)
    }
  }

  async function scanProfile() {
    if (!browser || !profileKey) return
    setDiscovery(null)
    setError(null)
    setScanning(true)
    const previousRequestId = activeRequestId.current
    if (previousRequestId) cancelRequest(previousRequestId)
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    try {
      const request = {
        requestId,
        providerId,
        browser,
      }
      const response = await discoverBrowserAccounts(
        profileKey === ALL_PROFILES ? request : { ...request, profileKey }
      )
      if (mounted.current && activeRequestId.current === requestId) {
        setDiscovery(response)
      }
    } catch (cause) {
      if (mounted.current && activeRequestId.current === requestId) {
        const nextError = typedError(
          cause,
          "Browser Discovery Error",
          "Browser accounts could not be discovered. Try again."
        )
        console.error("Failed to discover browser accounts", nextError.code)
        setError(nextError)
      }
    } finally {
      if (activeRequestId.current === requestId) {
        activeRequestId.current = null
        if (mounted.current) setScanning(false)
      }
    }
  }

  function displayName(targetProfileKey: string) {
    return (
      profiles.find((profile) => profile.profileKey === targetProfileKey)?.displayName ??
      targetProfileKey
    )
  }

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <Plus className="size-4" />
        Add Browser Account
      </Button>
    )
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">Add Browser Account</h4>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Close Add Browser Account"
          onClick={closeManager}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex gap-2">
        {(["Chrome", "Arc"] as const).map((option) => (
          <Button
            key={option}
            type="button"
            size="sm"
            variant={browser === option ? "default" : "outline"}
            disabled={loadingProfiles}
            onClick={() => void chooseBrowser(option)}
          >
            {option}
          </Button>
        ))}
      </div>

      {loadingProfiles ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading Browser Profiles…
        </p>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{error.title}</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      {browser && profilesListed && !loadingProfiles ? (
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Choose Profile</span>
          <select
            aria-label="Browser Profile"
            value={profileKey}
            onChange={(event) => setProfileKey(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-2"
          >
            <option value="" disabled>
              Choose A Profile
            </option>
            {providerId === "cursor" ? (
              <option value={ALL_PROFILES}>All Profiles</option>
            ) : null}
            {profiles.map((profile) => (
              <option key={profile.profileKey} value={profile.profileKey}>
                {profile.displayName} ({profile.profileKey})
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {browser && profilesListed && !loadingProfiles ? (
        <Button
          type="button"
          size="sm"
          disabled={!profileKey || busy}
          onClick={() => void scanProfile()}
        >
          {scanning ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <ScanSearch className="size-4" />
          )}
          {scanning
            ? "Scan Again"
            : profileKey === ALL_PROFILES
              ? "Scan Profiles"
              : "Scan Profile"}
        </Button>
      ) : null}

      {discovery ? (
        <div className="space-y-2">
          {discovery.partial ? (
            <Alert>
              <AlertTriangle className="size-4" />
              <AlertTitle>Browser Discovery Partial</AlertTitle>
              <AlertDescription>
                Some profiles could not be read. Verified accounts remain available to attach.
              </AlertDescription>
            </Alert>
          ) : null}
          {discovery.profiles.map((result) => {
            const profileName = displayName(result.profileKey)
            const candidate = result.candidate
            return (
              <div
                key={result.profileKey}
                className="flex items-center justify-between gap-3 rounded-md bg-muted/50 p-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{profileName}</p>
                  <p className="truncate text-xs text-muted-foreground">{result.profileKey}</p>
                </div>
                {result.status === "verified" && candidate ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="gap-1">
                      <ShieldCheck className="size-3" />
                      Verified
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        void onAttach(candidate.candidateId).then((receipt) => {
                          if (
                            mounted.current &&
                            receipt &&
                            receipt.status !== "failed"
                          ) {
                            closeManager()
                          }
                        })
                      }}
                    >
                      Attach {profileName}
                    </Button>
                  </div>
                ) : null}
                {result.status === "empty" ? (
                  <Badge variant="outline" className="gap-1">
                    <CircleSlash2 className="size-3" />
                    No Account
                  </Badge>
                ) : null}
                {result.status === "failed" ? (
                  <div className="max-w-60 text-right">
                    <Badge variant="outline" className="gap-1">
                      <CircleX className="size-3" />
                      Failed
                    </Badge>
                    {result.error ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {result.error.message}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
