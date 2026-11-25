// Plain Kubernetes object shapes: only the fields this adapter writes or reads (ADR 0106). No
// client library: these are the API's JSON, typed just enough to build and check manifests.

export type Labels = Record<string, string>;

export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Labels;
  deletionTimestamp?: string;
  /** Read only: the API server sets them. The run watcher keys a Job by its uid (D-330). */
  uid?: string;
  resourceVersion?: string;
  /** Read only. The runtime picks the newest of a Job's pods by it (D-415, ./pod-end.ts). */
  creationTimestamp?: string;
}

export interface LabelSelector {
  matchLabels: Labels;
  /** Used by the platform namespace's policies to select every agent namespace. */
  matchExpressions?: { key: string; operator: "Exists"; values?: never }[];
}

export interface ResourceList {
  cpu: string;
  memory: string;
  "ephemeral-storage": string;
}

export interface Resources {
  requests: ResourceList;
  limits: ResourceList;
}

export interface SecurityContext {
  runAsNonRoot: true;
  runAsUser: number;
  runAsGroup: number;
  readOnlyRootFilesystem: true;
  allowPrivilegeEscalation: false;
  privileged: false;
  capabilities: { drop: ["ALL"] };
  seccompProfile: { type: "RuntimeDefault" };
}

export interface PodSecurityContext {
  runAsNonRoot: true;
  runAsUser: number;
  runAsGroup: number;
  fsGroup: number;
  seccompProfile: { type: "RuntimeDefault" };
}

export type EnvVar =
  | { name: string; value: string }
  | {
      name: string;
      /** `optional`: the pod starts while the Secret does not exist yet, with the variable unset. */
      valueFrom: { secretKeyRef: { name: string; key: string; optional?: boolean } };
    }
  | {
      name: string;
      /** A field of the pod itself (the downward API), such as its IP address `status.podIP`. */
      valueFrom: { fieldRef: { fieldPath: "status.podIP" } };
    };

export interface VolumeMount {
  name: string;
  mountPath: string;
  readOnly: boolean;
  /** A folder inside the volume to mount instead of its root (D-389). */
  subPath?: string;
}

export type Volume =
  /** `medium: Memory` keeps the folder in memory, where it counts against the memory limit. */
  | { name: string; emptyDir: { sizeLimit: string; medium?: "Memory" } }
  | { name: string; persistentVolumeClaim: { claimName: string; readOnly: boolean } }
  | {
      name: string;
      secret: {
        secretName: string;
        items: { key: string; path: string }[];
        defaultMode: number;
      };
    };

export interface Container {
  name: string;
  image: string;
  imagePullPolicy: "IfNotPresent";
  /** Replaces the image's entrypoint and command; absent runs the image's own. */
  command?: string[];
  env: EnvVar[];
  ports?: { name: string; containerPort: number; protocol: "TCP" }[];
  readinessProbe?: {
    httpGet: { path: string; port: number };
    periodSeconds: number;
  };
  resources: Resources;
  securityContext: SecurityContext;
  volumeMounts: VolumeMount[];
}

export interface Toleration {
  key: string;
  operator: "Equal";
  value: string;
  effect: "NoSchedule";
}

export interface PodSpec {
  restartPolicy: "Never";
  automountServiceAccountToken: false;
  enableServiceLinks: false;
  hostNetwork: false;
  hostPID: false;
  hostIPC: false;
  terminationGracePeriodSeconds: number;
  nodeSelector: Labels;
  tolerations: Toleration[];
  securityContext: PodSecurityContext;
  containers: Container[];
  volumes: Volume[];
}

export interface Job {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: ObjectMeta;
  spec: {
    backoffLimit: 0;
    activeDeadlineSeconds: number;
    ttlSecondsAfterFinished: number;
    template: { metadata: { labels: Labels }; spec: PodSpec };
  };
}

export interface Service {
  apiVersion: "v1";
  kind: "Service";
  metadata: ObjectMeta;
  spec: {
    type: "ClusterIP";
    selector: Labels;
    ports: { name: string; protocol: "TCP"; port: number; targetPort: number }[];
  };
}

/**
 * Values go in `stringData`, or base64 encoded in `data` for bytes that are not text (the site's
 * zip, ADR 0119 slice 5b); the API server stores them. Never logged, never read back.
 */
export interface Secret {
  apiVersion: "v1";
  kind: "Secret";
  metadata: ObjectMeta;
  type: "Opaque";
  immutable: true;
  stringData: Record<string, string>;
  data?: Record<string, string>;
}

export interface NetworkPolicyPeer {
  podSelector?: LabelSelector;
  namespaceSelector?: LabelSelector;
  ipBlock?: { cidr: string; except: string[] };
}

export interface PolicyPort {
  protocol: "TCP" | "UDP";
  port: number;
}

export interface NetworkPolicy {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  metadata: ObjectMeta;
  spec: {
    podSelector: LabelSelector | Record<string, never>;
    policyTypes: ("Ingress" | "Egress")[];
    ingress: { from: NetworkPolicyPeer[]; ports: PolicyPort[] }[];
    egress: { to: NetworkPolicyPeer[]; ports: PolicyPort[] }[];
  };
}

export interface PersistentVolumeClaim {
  apiVersion: "v1";
  kind: "PersistentVolumeClaim";
  metadata: ObjectMeta;
  spec: {
    accessModes: ["ReadWriteOnce"];
    resources: { requests: { storage: string } };
    storageClassName?: string;
  };
}

/** The kinds the runner creates and deletes in an agent namespace (ADR 0106 section 1). */
export type RunObject = Job | Service | Secret | NetworkPolicy | PersistentVolumeClaim;
export type RunObjectKind = RunObject["kind"];

/** What `poll` reads from a Job. */
export interface JobStatus {
  metadata: ObjectMeta;
  status?: {
    conditions?: { type: string; status: string; reason?: string }[];
    startTime?: string;
    completionTime?: string;
  };
}

/**
 * What `poll` reads from a Pod: its phase and how it ended (D-415, ./pod-end.ts). Kubernetes'
 * free-text `message` fields are left out on purpose, so nothing here reads or keeps them.
 */
export interface PodStatus {
  metadata: ObjectMeta;
  status?: {
    phase?: string;
    /** Set when the kubelet ended or refused the pod itself, for example `Evicted`. */
    reason?: string;
    containerStatuses?: ContainerStatus[];
  };
}

/** What `poll` reads of one container in a Pod's status: how it terminated, if it did. */
export interface ContainerStatus {
  name: string;
  state?: { terminated?: { reason?: string; exitCode?: number } };
}

// Namespace-level objects. Infrastructure code applies them (ADR 0106 section 1); the runner
// never creates them and has no right to.

export interface Namespace {
  apiVersion: "v1";
  kind: "Namespace";
  metadata: ObjectMeta;
}

export interface ResourceQuota {
  apiVersion: "v1";
  kind: "ResourceQuota";
  metadata: ObjectMeta;
  spec: { hard: Record<string, string> };
}

export interface ServiceAccount {
  apiVersion: "v1";
  kind: "ServiceAccount";
  metadata: ObjectMeta;
  automountServiceAccountToken: false;
}

export interface PolicyRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

export interface Role {
  apiVersion: "rbac.authorization.k8s.io/v1";
  kind: "Role";
  metadata: ObjectMeta;
  rules: PolicyRule[];
}

export interface RoleBinding {
  apiVersion: "rbac.authorization.k8s.io/v1";
  kind: "RoleBinding";
  metadata: ObjectMeta;
  roleRef: { apiGroup: "rbac.authorization.k8s.io"; kind: "Role"; name: string };
  subjects: { kind: "ServiceAccount"; name: string; namespace: string }[];
}

export type NamespaceObject =
  Namespace | NetworkPolicy | ResourceQuota | ServiceAccount | Role | RoleBinding;
