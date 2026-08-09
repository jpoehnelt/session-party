import { useEffect, useState } from "react";
import { Button, Card, EmptyState, Skeleton } from "@/ui";

export type RouteLoad<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: T }
  | { readonly status: "error"; readonly message: string };

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
      <Skeleton className="h-20 motion-reduce:animate-none" />
      <Skeleton className="h-72 motion-reduce:animate-none" />
    </div>
  );
}

export function RouteFailure({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <Card>
      <EmptyState
        title="Portal could not load"
        description={message}
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    </Card>
  );
}
