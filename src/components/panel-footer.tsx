import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { UpdateStatus } from "@/hooks/use-app-update";

interface PanelFooterProps {
  version: string;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  updateStatus: UpdateStatus;
  onUpdateInstall: () => void;
}

function VersionDisplay({
  version,
  updateStatus,
  onUpdateInstall,
}: {
  version: string;
  updateStatus: UpdateStatus;
  onUpdateInstall: () => void;
}) {
  switch (updateStatus.status) {
    case "downloading":
      return (
        <span className="text-xs text-muted-foreground">
          {updateStatus.progress >= 0
            ? `Downloading update ${updateStatus.progress}%`
            : "Downloading update..."}
        </span>
      );
    case "ready":
      return (
        <Button
          variant="destructive"
          size="xs"
          onClick={onUpdateInstall}
        >
          Restart to update
        </Button>
      );
    case "installing":
      return (
        <span className="text-xs text-muted-foreground">Installing...</span>
      );
    case "error":
      return (
        <span className="text-xs text-destructive" title={updateStatus.message}>
          Update failed
        </span>
      );
    default:
      return (
        <span className="text-xs text-muted-foreground">
          OpenUsage {version}
        </span>
      );
  }
}

export function PanelFooter({
  version,
  onRefresh,
  refreshDisabled,
  updateStatus,
  onUpdateInstall,
}: PanelFooterProps) {
  return (
    <div className="flex justify-between items-center pt-1.5 border-t">
      <VersionDisplay
        version={version}
        updateStatus={updateStatus}
        onUpdateInstall={onUpdateInstall}
      />
      {refreshDisabled ? (
        <Tooltip>
          <TooltipTrigger
            render={(props) => (
              <span {...props}>
                <Button
                  variant="link"
                  size="sm"
                  className="px-0 text-xs pointer-events-none opacity-50"
                  tabIndex={-1}
                >
                  Refresh all
                </Button>
              </span>
            )}
          />
          <TooltipContent side="top">
            All plugins recently refreshed
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          variant="link"
          size="sm"
          onClick={onRefresh}
          className="px-0 text-xs"
        >
          Refresh all
        </Button>
      )}
    </div>
  );
}
