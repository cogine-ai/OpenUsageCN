import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PanelFooterProps {
  version: string;
  onRefresh: () => void;
  refreshDisabled?: boolean;
}

export function PanelFooter({ version, onRefresh, refreshDisabled }: PanelFooterProps) {
  return (
    <div className="flex justify-between items-center pt-3 border-t">
      <span className="text-sm text-muted-foreground">OpenUsage {version}</span>
      {refreshDisabled ? (
        <Tooltip>
          <TooltipTrigger>
            <Button
              variant="link"
              size="sm"
              className="px-0 pointer-events-none opacity-50"
              tabIndex={-1}
            >
              Refresh all
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            All plugins recently refreshed
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          variant="link"
          size="sm"
          onClick={onRefresh}
          className="px-0"
        >
          Refresh all
        </Button>
      )}
    </div>
  );
}
