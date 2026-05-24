import { useCallback, useRef, useState } from "react";
import { AI_QUICK_ACTIONS } from "../app/constants";

export function AiPage() {
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const sendMessage = useCallback(() => {
    const text = chatInput.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { role: "user", text },
      {
        role: "assistant",
        text: "AI assistant is coming soon. For now, use the Portivox docs or the CLI help command: portivox --help",
      },
    ]);
    setChatInput("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [chatInput]);

  return (
    <div className="page">
      <div className="ai-page-banner">
        <div className="ai-page-text">
          <div className="ai-page-title">
            AI Assistant
            <span style={{ fontSize: 11, fontWeight: 500, background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.8)", padding: "2px 9px", borderRadius: 20, marginLeft: 10 }}>
              Coming soon
            </span>
          </div>
          <div className="ai-page-sub">
            Natural language interface for your tunnels. Ask about setup, diagnostics,
            security review, or CLI commands.
          </div>
        </div>
        <i className="ti ti-robot ai-page-icon" />
      </div>

      {messages.length > 0 && (
        <div className="section">
          {messages.map((message, index) => (
            <div
              key={index}
              style={{
                padding: "14px 22px",
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                borderBottom: "1px solid var(--border)",
                background: message.role === "assistant" ? "var(--bg-secondary)" : undefined,
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  flexShrink: 0,
                  background: message.role === "user" ? "var(--accent)" : "var(--accent-bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  color: message.role === "user" ? "#fff" : "var(--accent)",
                }}
              >
                <i className={`ti ${message.role === "user" ? "ti-user" : "ti-robot"}`} />
              </div>
              <div style={{ fontSize: 13, color: "var(--text-1)", lineHeight: 1.65, paddingTop: 4 }}>
                {message.text}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section">
        <div className="section-head">
          <div className="section-title"><i className="ti ti-bolt" /> Quick actions</div>
        </div>
        <div className="ai-grid">
          {AI_QUICK_ACTIONS.map((card) => (
            <button key={card.title} className="ai-card" onClick={() => setChatInput(card.prompt)}>
              <div className="ai-card-icon"><i className={`ti ${card.icon}`} /></div>
              <div>
                <div className="ai-card-title">{card.title}</div>
                <div className="ai-card-desc">{card.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <div style={{ padding: "14px 22px", display: "flex", gap: 10 }}>
          <input
            ref={inputRef}
            className="form-inp"
            style={{ flex: 1 }}
            placeholder="Ask about your tunnels, CLI commands, or setup..."
            value={chatInput}
            onChange={(event) => setChatInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && sendMessage()}
          />
          <button className="btn-primary" onClick={sendMessage} disabled={!chatInput.trim()}>
            <i className="ti ti-send" /> Send
          </button>
        </div>
      </div>
    </div>
  );
}
