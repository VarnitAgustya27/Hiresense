import { useState, useEffect, useCallback } from "react";
import { listApplications, getApplication, type ApplicationRecord } from "@/lib/applications";

export function useApplications(userId: string) {
  const [applications, setApplications] = useState<ApplicationRecord[]>(() =>
    listApplications(userId),
  );

  const refresh = useCallback(() => {
    setApplications(listApplications(userId));
  }, [userId]);

  useEffect(() => {
    refresh();

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key && e.key.includes("hiresense_applications_")) {
        refresh();
      }
    };

    const handleCustomChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ userId?: string }>;
      if (!customEvent.detail || customEvent.detail.userId === userId) {
        refresh();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("hiresense_applications_changed", handleCustomChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("hiresense_applications_changed", handleCustomChange);
    };
  }, [userId, refresh]);

  return { applications, refresh };
}

export function useJobApplication(userId: string, jobId: string) {
  const [application, setApplication] = useState<ApplicationRecord | null>(() =>
    getApplication(userId, jobId),
  );

  const refresh = useCallback(() => {
    setApplication(getApplication(userId, jobId));
  }, [userId, jobId]);

  useEffect(() => {
    refresh();

    const handleCustomChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ userId?: string; jobId?: string }>;
      if (
        !customEvent.detail ||
        (customEvent.detail.jobId === jobId && customEvent.detail.userId === userId)
      ) {
        refresh();
      }
    };

    window.addEventListener("storage", refresh);
    window.addEventListener("hiresense_applications_changed", handleCustomChange);

    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("hiresense_applications_changed", handleCustomChange);
    };
  }, [userId, jobId, refresh]);

  return { application, refresh };
}
