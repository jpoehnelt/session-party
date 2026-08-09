import { useEffect, useState } from "react";
import { Button, Card, EmptyState, Skeleton } from "@/ui";
import { productionButtonClass, productionCardClass } from "./production-ui";

export type RouteLoad<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly message: string; readonly error: unknown };

export function useRouteLoad<T>(load: () => Promise<T>, key: string): readonly [RouteLoad<T>, () => void] {
  const [request, setRequest] = useState(0);
  const [state, setState] = useState<RouteLoad<T>>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void load().then(
      (data) => {
        if (active) setState({ status: "ready", data });
      },
      (error: unknown) => {
        if (active) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "The portal could not be loaded",
            error,
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [key, request]);

  return [state, () => setRequest((current) => current + 1)] as const;
}

export function RouteLoading({ label }: { readonly label: string }) {
  return (
    <div className="space-y-5" role="status" aria-label={label} aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="border-[3px] border-[#171714] bg-[#fffdf7] p-5 shadow-[7px_7px_0_#171714]">
        <Skeleton className="h-20 rounded-none bg-[#d8d1c3] motion-reduce:animate-none" />
      </div>
      <div className="border-2 border-[#171714] bg-[#ece8dc] p-5 shadow-[6px_6px_0_#7857ff]">
        <Skeleton className="h-72 rounded-none bg-[#d8d1c3] motion-reduce:animate-none" />
      </div>
    </div>
  );
}

export function RouteFailure({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <Card className={productionCardClass}>
      <EmptyState
        title="Portal could not load"
        description={message}
        action={<Button className={`${productionButtonClass} bg-[#ff714f] text-[#171714]`} onClick={onRetry}>Try again</Button>}
      />
    </Card>
  );
}
