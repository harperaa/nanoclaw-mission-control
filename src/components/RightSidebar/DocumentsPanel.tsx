import React, { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";

function formatRelativeTime(timestamp: number, now: number): string {
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const typeFilters = [
  { id: "all", label: "All" },
  { id: "markdown", label: "Markdown" },
  { id: "code", label: "Code" },
  { id: "image", label: "Images" },
  { id: "note", label: "Notes" },
];

type DocumentsPanelProps = {
  selectedDocumentId: Id<"documents"> | null;
  onSelectDocument: (id: Id<"documents"> | null) => void;
  onPreviewDocument: (id: Id<"documents">) => void;
};

const DocumentsPanel: React.FC<DocumentsPanelProps> = ({
  selectedDocumentId,
  onSelectDocument,
  onPreviewDocument,
}) => {
  const [selectedType, setSelectedType] = useState<string>("all");
  const [selectedAgentId, setSelectedAgentId] = useState<
    Id<"agents"> | undefined
  >(undefined);
  const [searchQuery, setSearchQuery] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const allDocuments = useQuery(api.documents.listAll, {
    type: selectedType === "all" ? undefined : selectedType,
    agentId: selectedAgentId,
  });
  const agents = useQuery(api.queries.listAgents);

  const documents = React.useMemo(() => {
    if (!allDocuments) return undefined;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allDocuments;
    return allDocuments.filter(
      (doc) =>
        doc.title.toLowerCase().includes(q) ||
        doc.content.toLowerCase().includes(q) ||
        (doc.path && doc.path.toLowerCase().includes(q)),
    );
  }, [allDocuments, searchQuery]);

  const handleDocumentClick = (docId: Id<"documents">) => {
    if (selectedDocumentId === docId) {
      // Clicking same document again - close trays
      onSelectDocument(null);
    } else {
      // Click opens both conversation and preview
      onSelectDocument(docId);
    }
  };

  if (documents === undefined || agents === undefined) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden animate-pulse">
        <div className="flex-1 p-4 space-y-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 bg-muted rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "markdown":
        return "M";
      case "code":
        return "</>";
      case "image":
        return "IMG";
      case "note":
        return "N";
      default:
        return "D";
    }
  };

  const getMatchSnippet = (content: string, query: string): string | null => {
    if (!query) return null;
    const lower = content.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx === -1) return null;
    const start = Math.max(0, idx - 30);
    const end = Math.min(content.length, idx + query.length + 50);
    let snippet = content.slice(start, end).replace(/\n/g, " ");
    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";
    return snippet;
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "markdown":
        return "bg-blue-100 text-blue-700";
      case "code":
        return "bg-green-100 text-green-700";
      case "image":
        return "bg-purple-100 text-purple-700";
      case "note":
        return "bg-yellow-100 text-yellow-700";
      default:
        return "bg-gray-100 text-gray-700";
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-4 gap-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-1.5">
          {typeFilters.map((f) => (
            <div
              key={f.id}
              onClick={() => setSelectedType(f.id)}
              className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border border-border cursor-pointer flex items-center gap-1 transition-colors ${
                selectedType === f.id
                  ? "bg-[var(--accent-orange)] text-white border-[var(--accent-orange)]"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {f.label}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <div
            onClick={() => setSelectedAgentId(undefined)}
            className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border cursor-pointer transition-colors ${
              selectedAgentId === undefined
                ? "border-[var(--accent-orange)] text-[var(--accent-orange)] bg-white"
                : "border-border bg-white text-muted-foreground hover:bg-muted/50"
            }`}
          >
            All Agents
          </div>
          {agents.slice(0, 8).map((a) => (
            <div
              key={a._id}
              onClick={() => setSelectedAgentId(a._id)}
              className={`text-[10px] font-semibold px-2.5 py-1 rounded-full border cursor-pointer flex items-center gap-1 transition-colors ${
                selectedAgentId === a._id
                  ? "border-[var(--accent-orange)] text-[var(--accent-orange)] bg-white"
                  : "border-border bg-white text-muted-foreground hover:bg-muted/50"
              }`}
            >
              {a.name}
            </div>
          ))}
        </div>

        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search documents..."
            className="w-full text-xs bg-secondary border border-border rounded-md pl-7 pr-7 py-1.5 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--accent-orange)] focus:border-[var(--accent-orange)]"
          />
          <svg
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="8" strokeWidth="2" />
            <path d="m21 21-4.3-4.3" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path d="M18 6 6 18M6 6l12 12" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {documents.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">
            No documents found
          </div>
        ) : (
          documents.map((doc) => (
            <div
              key={doc._id}
              onClick={() => handleDocumentClick(doc._id)}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selectedDocumentId === doc._id
                  ? "bg-[var(--accent-orange)]/10 border-[var(--accent-orange)]"
                  : "bg-secondary border-border hover:bg-muted"
              }`}
            >
              <div
                className={`shrink-0 w-8 h-8 rounded flex items-center justify-center text-[10px] font-bold ${getTypeColor(doc.type)}`}
              >
                {getTypeIcon(doc.type)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-foreground truncate">
                  {doc.title}
                </div>
                <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  {doc.agentName && (
                    <span className="text-[var(--accent-orange)]">
                      {doc.agentName}
                    </span>
                  )}
                  <span>{doc.type}</span>
                </div>
                {searchQuery.trim() && (() => {
                  const snippet = getMatchSnippet(doc.content, searchQuery.trim());
                  return snippet ? (
                    <div className="text-[10px] text-muted-foreground mt-1 line-clamp-2 italic">
                      {snippet}
                    </div>
                  ) : null;
                })()}
                <div className="text-[10px] text-muted-foreground mt-1">
                  {formatRelativeTime(doc._creationTime, now)}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreviewDocument(doc._id);
                }}
                className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded bg-muted hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                Preview
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default DocumentsPanel;
