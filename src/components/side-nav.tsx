import { Home, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

type ActiveView = "home" | "settings" | string

interface NavPlugin {
  id: string
  name: string
  iconUrl: string
}

interface SideNavProps {
  activeView: ActiveView
  onViewChange: (view: ActiveView) => void
  plugins: NavPlugin[]
}

interface NavButtonProps {
  isActive: boolean
  onClick: () => void
  children: React.ReactNode
}

function NavButton({ isActive, onClick, children }: NavButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex items-center justify-center w-full p-2.5 transition-colors",
        "hover:bg-accent",
        isActive
          ? "text-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:bg-primary before:rounded-full"
          : "text-muted-foreground"
      )}
    >
      {children}
    </button>
  )
}

export function SideNav({ activeView, onViewChange, plugins }: SideNavProps) {
  return (
    <nav className="flex flex-col w-12 border-r bg-muted/30 py-3">
      {/* Home */}
      <NavButton
        isActive={activeView === "home"}
        onClick={() => onViewChange("home")}
      >
        <Home className="size-6" />
      </NavButton>

      {/* Plugin icons */}
      {plugins.map((plugin) => (
        <NavButton
          key={plugin.id}
          isActive={activeView === plugin.id}
          onClick={() => onViewChange(plugin.id)}
        >
          <img
            src={plugin.iconUrl}
            alt={plugin.name}
            className="size-6"
          />
        </NavButton>
      ))}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Settings */}
      <NavButton
        isActive={activeView === "settings"}
        onClick={() => onViewChange("settings")}
      >
        <Settings className="size-6" />
      </NavButton>
    </nav>
  )
}

export type { ActiveView, NavPlugin }
