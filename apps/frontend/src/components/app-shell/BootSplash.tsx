export function BootSplash() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--bg-page)",
        gap: 16,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: "var(--accent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 22,
          color: "#fff",
        }}
      >
        <i className="ti ti-topology-star" />
      </div>
      <i className="ti ti-loader-2 spin" style={{ fontSize: 24, color: "var(--accent)" }} />
    </div>
  );
}
