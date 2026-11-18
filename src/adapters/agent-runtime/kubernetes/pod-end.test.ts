import { describe, expect, it } from "vitest";

import type { PodStatus } from "./objects.ts";
import { POD_END_REASONS, podEnd, runPod } from "./pod-end.ts";

// Unit: which of a Job's pods is the run's, and how it ended (D-415). Made-up pods only, shaped
// as the Kubernetes API lists them, free-text messages included, so the tests can show they are
// never kept.

const MESSAGE = "made-up kubelet message naming node-7 and 3.2Gi";

function pod(
  name: string,
  status: Record<string, unknown> | undefined,
  creationTimestamp?: string,
): PodStatus {
  return {
    metadata: { name, ...(creationTimestamp ? { creationTimestamp } : {}) },
    ...(status === undefined ? {} : { status }),
  } as PodStatus;
}

const terminatedAgent = (reason: string | undefined, exitCode: unknown) => ({
  name: "agent",
  state: {
    terminated: {
      ...(reason === undefined ? {} : { reason }),
      exitCode,
      message: MESSAGE,
      startedAt: "2026-11-18T10:00:00Z",
      finishedAt: "2026-11-18T10:03:00Z",
    },
  },
});

describe("podEnd (unit: the pod's end reason and exit code, D-415)", () => {
  it("reads an out-of-memory kill from the main container", () => {
    const oom = pod("p", {
      phase: "Failed",
      containerStatuses: [terminatedAgent("OOMKilled", 137)],
    });
    expect(podEnd(oom, "agent")).toEqual({ podReason: "OOMKilled", exitCode: 137 });
  });

  it("puts the pod's own reason first, so an eviction reads Evicted", () => {
    const evicted = pod("p", {
      phase: "Failed",
      reason: "Evicted",
      message: MESSAGE,
      containerStatuses: [terminatedAgent("ContainerStatusUnknown", 137)],
    });
    expect(podEnd(evicted, "agent")).toEqual({ podReason: "Evicted", exitCode: 137 });
    // An evicted pod whose container never ran has a reason and no exit code.
    const early = pod("p", { phase: "Failed", reason: "Evicted", message: MESSAGE });
    expect(podEnd(early, "agent")).toEqual({ podReason: "Evicted" });
  });

  it("reads a plain error and a clean exit with their codes", () => {
    const error = pod("p", { containerStatuses: [terminatedAgent("Error", 1)] });
    expect(podEnd(error, "agent")).toEqual({ podReason: "Error", exitCode: 1 });
    const clean = pod("p", { containerStatuses: [terminatedAgent("Completed", 0)] });
    expect(podEnd(clean, "agent")).toEqual({ podReason: "Completed", exitCode: 0 });
  });

  it("keeps every word of the list as it is", () => {
    for (const reason of POD_END_REASONS) {
      expect(podEnd(pod("p", { reason }), "agent")).toEqual({ podReason: reason });
    }
  });

  it("reads any other word as other, and a known word behind an unknown one", () => {
    const unknown = pod("p", {
      containerStatuses: [terminatedAgent("Made up reason with spaces", 2)],
    });
    expect(podEnd(unknown, "agent")).toEqual({ podReason: "other", exitCode: 2 });
    const both = pod("p", {
      reason: "SomeNewReason",
      containerStatuses: [terminatedAgent("OOMKilled", 137)],
    });
    expect(podEnd(both, "agent")).toEqual({ podReason: "OOMKilled", exitCode: 137 });
    // The list is matched exactly: a different case is another word.
    expect(podEnd(pod("p", { reason: "evicted" }), "agent")).toEqual({
      podReason: "other",
    });
  });

  it("never keeps a message or any other field of the status", () => {
    const evicted = pod("p", {
      phase: "Failed",
      reason: "Evicted",
      message: MESSAGE,
      containerStatuses: [terminatedAgent("Error", 137)],
    });
    const end = podEnd(evicted, "agent");
    expect(Object.keys(end ?? {}).sort()).toEqual(["exitCode", "podReason"]);
    expect(JSON.stringify(end)).not.toContain("node-7");
  });

  it("reads only the main container", () => {
    const sidecar = pod("p", {
      containerStatuses: [
        {
          name: "other",
          state: { terminated: { reason: "OOMKilled", exitCode: 137 } },
        },
      ],
    });
    expect(podEnd(sidecar, "agent")).toBeNull();
  });

  it("keeps an exit code only when it is a whole number Kubernetes can hold", () => {
    for (const code of [1.5, "137", null, Number.NaN, 2 ** 31, -(2 ** 31) - 1]) {
      const odd = pod("p", { containerStatuses: [terminatedAgent("Error", code)] });
      expect(podEnd(odd, "agent")).toEqual({ podReason: "Error" });
    }
    const signed = pod("p", { containerStatuses: [terminatedAgent(undefined, -1)] });
    expect(podEnd(signed, "agent")).toEqual({ exitCode: -1 });
  });

  it("gives no detail, and never throws, for a missing or unreadable pod", () => {
    expect(podEnd(null, "agent")).toBeNull();
    for (const status of [
      undefined,
      {},
      { phase: "Failed" },
      { reason: "" },
      { reason: 42 },
      { containerStatuses: "agent" },
      { containerStatuses: [null, "agent", { name: "agent" }] },
      { containerStatuses: [{ name: "agent", state: null }] },
      { containerStatuses: [{ name: "agent", state: { running: {} } }] },
      { containerStatuses: [{ name: "agent", state: { terminated: "OOMKilled" } }] },
      { containerStatuses: [{ name: "agent", state: { terminated: { reason: 9 } } }] },
    ]) {
      expect(podEnd(pod("p", status), "agent")).toBeNull();
    }
    expect(
      podEnd({ metadata: { name: "p" }, status: "Failed" } as never, "agent"),
    ).toBeNull();
  });
});

describe("runPod (unit: which of a Job's pods is the run's, D-415)", () => {
  const ended = (name: string, created?: string) =>
    pod(
      name,
      { phase: "Failed", containerStatuses: [terminatedAgent("Error", 1)] },
      created,
    );
  const running = (name: string, created?: string) =>
    pod(name, { phase: "Running" }, created);

  it("is null when the Job has no pod", () => {
    expect(runPod([], "agent")).toBeNull();
  });

  it("takes the newest pod that ended over a newer one that did not", () => {
    const pods = [
      ended("run-x-agent-aaaaa", "2026-11-18T10:00:00Z"),
      ended("run-x-agent-bbbbb", "2026-11-18T10:05:00Z"),
      running("run-x-agent-ccccc", "2026-11-18T10:09:00Z"),
    ];
    expect(runPod(pods, "agent")?.metadata.name).toBe("run-x-agent-bbbbb");
  });

  it("counts a pod as ended by its phase or by its main container", () => {
    const byPhase = pod(
      "run-x-agent-bbbbb",
      { phase: "Succeeded" },
      "2026-11-18T10:05:00Z",
    );
    const byContainer = pod(
      "run-x-agent-aaaaa",
      { phase: "Running", containerStatuses: [terminatedAgent("OOMKilled", 137)] },
      "2026-11-18T10:01:00Z",
    );
    const later = running("run-x-agent-ccccc", "2026-11-18T10:09:00Z");
    expect(runPod([byContainer, later], "agent")?.metadata.name).toBe(
      "run-x-agent-aaaaa",
    );
    expect(runPod([byContainer, byPhase, later], "agent")?.metadata.name).toBe(
      "run-x-agent-bbbbb",
    );
  });

  it("takes the newest pod when none has ended", () => {
    const pods = [
      running("run-x-agent-bbbbb", "2026-11-18T10:00:00Z"),
      running("run-x-agent-aaaaa", "2026-11-18T10:05:00Z"),
    ];
    expect(runPod(pods, "agent")?.metadata.name).toBe("run-x-agent-aaaaa");
  });

  it("goes by name for a tie or no readable creation time, and puts those last", () => {
    expect(
      runPod([ended("run-x-agent-bbbbb"), ended("run-x-agent-aaaaa")], "agent")
        ?.metadata.name,
    ).toBe("run-x-agent-aaaaa");
    const pods = [
      ended("run-x-agent-aaaaa", "not a time"),
      ended("run-x-agent-bbbbb", "2026-11-18T10:00:00Z"),
    ];
    expect(runPod(pods, "agent")?.metadata.name).toBe("run-x-agent-bbbbb");
  });

  it("skips an entry it cannot read rather than throwing", () => {
    const pods: unknown[] = [
      null,
      "pod",
      { metadata: {} },
      { status: {} },
      ended("run-x-agent-aaaaa"),
    ];
    expect(runPod(pods, "agent")?.metadata.name).toBe("run-x-agent-aaaaa");
    expect(runPod([null, { metadata: { name: 7 } }], "agent")).toBeNull();
  });
});
