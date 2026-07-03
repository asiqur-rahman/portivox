type CounterName =
  | "gateway_requests_total"
  | "gateway_request_errors_total"
  | "gateway_ws_connections_total"
  | "gateway_ws_auth_failures_total"
  | "gateway_ws_socket_errors_total"
  | "gateway_ws_rejected_draining_total"
  | "gateway_chunk_frames_total"
  | "gateway_chunk_reassembled_streams_total"
  | "gateway_chunk_incomplete_timeouts_total"
  | "gateway_registry_lease_lost_total"
  | "gateway_registry_stale_evictions_total"
  | "gateway_drain_state_transitions_total";

type GaugeName =
  | "gateway_active_tunnels"
  | "gateway_draining_state"
  | "gateway_maintenance_mode_state";

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class GatewayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly labeledCounters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly latencyBuckets = new Map<number, number>();
  private latencySum = 0;
  private latencyCount = 0;

  constructor() {
    for (const bucket of DEFAULT_BUCKETS) {
      this.latencyBuckets.set(bucket, 0);
    }
  }

  increment(name: CounterName, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  incrementLabeled(name: string, labels: Record<string, string>, value = 1): void {
    const key = `${name}{${serializeLabels(labels)}}`;
    this.labeledCounters.set(key, (this.labeledCounters.get(key) ?? 0) + value);
  }

  setGauge(name: GaugeName, value: number): void {
    this.gauges.set(name, value);
  }

  observeRequestLatency(durationMs: number): void {
    this.latencySum += durationMs;
    this.latencyCount += 1;
    for (const bucket of DEFAULT_BUCKETS) {
      if (durationMs <= bucket) {
        this.latencyBuckets.set(bucket, (this.latencyBuckets.get(bucket) ?? 0) + 1);
      }
    }
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    appendSimpleMetric(lines, "gateway_requests_total", "counter", "Total inbound gateway requests", this.counters);
    appendSimpleMetric(lines, "gateway_request_errors_total", "counter", "Total gateway request errors", this.counters);
    appendSimpleMetric(lines, "gateway_ws_connections_total", "counter", "Total websocket connections accepted", this.counters);
    appendSimpleMetric(lines, "gateway_ws_auth_failures_total", "counter", "Total websocket auth failures", this.counters);
    appendSimpleMetric(lines, "gateway_ws_socket_errors_total", "counter", "Total websocket socket-level errors", this.counters);
    appendSimpleMetric(lines, "gateway_ws_rejected_draining_total", "counter", "Total websocket connections rejected while draining or in maintenance", this.counters);
    appendSimpleMetric(lines, "gateway_chunk_frames_total", "counter", "Total chunk frames received from tunnel clients", this.counters);
    appendSimpleMetric(lines, "gateway_chunk_reassembled_streams_total", "counter", "Total chunked streams successfully reassembled", this.counters);
    appendSimpleMetric(lines, "gateway_chunk_incomplete_timeouts_total", "counter", "Total chunked streams timed out before completion", this.counters);
    appendSimpleMetric(lines, "gateway_registry_lease_lost_total", "counter", "Total tunnel sessions closed because the distributed lease was lost", this.counters);
    appendSimpleMetric(lines, "gateway_registry_stale_evictions_total", "counter", "Total stale tunnel sessions proactively evicted", this.counters);
    appendSimpleMetric(lines, "gateway_drain_state_transitions_total", "counter", "Total admin drain or maintenance state transitions", this.counters);

    appendSimpleMetric(lines, "gateway_active_tunnels", "gauge", "Active local tunnels on this gateway node", this.gauges);
    appendSimpleMetric(lines, "gateway_draining_state", "gauge", "1 when the node is draining, otherwise 0", this.gauges);
    appendSimpleMetric(lines, "gateway_maintenance_mode_state", "gauge", "1 when maintenance mode is enabled, otherwise 0", this.gauges);

    lines.push("# HELP gateway_requests_labeled_total Gateway requests by endpoint/method/status_class");
    lines.push("# TYPE gateway_requests_labeled_total counter");
    appendMetricLines(lines, this.labeledCounters, "gateway_requests_labeled_total");

    lines.push("# HELP gateway_errors_labeled_total Gateway errors by endpoint/error_code");
    lines.push("# TYPE gateway_errors_labeled_total counter");
    appendMetricLines(lines, this.labeledCounters, "gateway_errors_labeled_total");

    lines.push("# HELP gateway_tunnel_request_duration_ms Tunnel request duration in milliseconds");
    lines.push("# TYPE gateway_tunnel_request_duration_ms histogram");
    for (const bucket of DEFAULT_BUCKETS) {
      lines.push(`gateway_tunnel_request_duration_ms_bucket{le="${bucket}"} ${this.latencyBuckets.get(bucket) ?? 0}`);
    }
    lines.push(`gateway_tunnel_request_duration_ms_bucket{le="+Inf"} ${this.latencyCount}`);
    lines.push(`gateway_tunnel_request_duration_ms_sum ${this.latencySum}`);
    lines.push(`gateway_tunnel_request_duration_ms_count ${this.latencyCount}`);

    return `${lines.join("\n")}\n`;
  }
}

function appendSimpleMetric(
  lines: string[],
  name: string,
  type: "counter" | "gauge",
  help: string,
  source: Map<string, number>,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  lines.push(`${name} ${source.get(name) ?? 0}`);
}

function serializeLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function appendMetricLines(lines: string[], source: Map<string, number>, metricName: string): void {
  const entries = [...source.entries()]
    .filter(([key]) => key.startsWith(`${metricName}{`))
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    lines.push(`${metricName}{endpoint="none"} 0`);
    return;
  }

  for (const [key, value] of entries) {
    lines.push(`${key} ${value}`);
  }
}
