import { useEffect, useRef, useState } from "react";
import type { Project } from "../api/client";

interface ProjectPickerProps {
  projects: Project[];
  selectedProject: Project | null;
  languageId: string | null;
  onSelectProject: (project: Project) => void;
  onSelectLanguage: (languageId: string) => void;
}

type OpenMenu = "project" | "language" | null;

/** Header title, doubling as the project + target-language switcher.
 * Used to be plain "<project name> · <language>" text sitting next to a
 * pair of permanent <select>s — replaced with the text itself acting as
 * the control: underlined to read as clickable, expanding into a small
 * anchored menu on click rather than a pair of dropdowns permanently
 * cluttering the header. */
export function ProjectPicker({
  projects,
  selectedProject,
  languageId,
  onSelectProject,
  onSelectLanguage,
}: ProjectPickerProps) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const containerRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  if (!selectedProject) return null;

  const languageName = selectedProject.target_languages.find((l) => l.id === languageId)?.name ?? languageId;
  const showLanguagePicker = selectedProject.target_languages.length > 1;

  return (
    <h1 className="header-title" ref={containerRef}>
      <span className="header-picker">
        <button
          type="button"
          className="header-picker-trigger"
          onClick={() => setOpenMenu(openMenu === "project" ? null : "project")}
        >
          {selectedProject.name}
        </button>
        {openMenu === "project" && (
          <div className="header-picker-menu">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={p.id === selectedProject.id ? "active" : ""}
                onClick={() => {
                  onSelectProject(p);
                  setOpenMenu(null);
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </span>
      <span className="header-title-sep"> · </span>
      {showLanguagePicker ? (
        <span className="header-picker">
          <button
            type="button"
            className="header-picker-trigger"
            onClick={() => setOpenMenu(openMenu === "language" ? null : "language")}
          >
            {languageName}
          </button>
          {openMenu === "language" && (
            <div className="header-picker-menu">
              {selectedProject.target_languages.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={l.id === languageId ? "active" : ""}
                  onClick={() => {
                    onSelectLanguage(l.id);
                    setOpenMenu(null);
                  }}
                >
                  {l.name}
                </button>
              ))}
            </div>
          )}
        </span>
      ) : (
        <span className="header-title-static">{languageName}</span>
      )}
    </h1>
  );
}
