import type { Project } from "../api/client";

interface ProjectPickerProps {
  projects: Project[];
  selectedProject: Project | null;
  languageId: string | null;
  onSelectProject: (project: Project) => void;
  onSelectLanguage: (languageId: string) => void;
}

/** Project + target-language switcher for the header. Kept as two plain
 * <select>s rather than a fancier combobox — this app is a personal
 * tool for a handful of Crowdin projects at most, not a directory. */
export function ProjectPicker({
  projects,
  selectedProject,
  languageId,
  onSelectProject,
  onSelectLanguage,
}: ProjectPickerProps) {
  return (
    <div className="project-picker">
      <select
        className="project-picker-project"
        value={selectedProject?.id ?? ""}
        onChange={(e) => {
          const project = projects.find((p) => p.id === Number(e.target.value));
          if (project) onSelectProject(project);
        }}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {selectedProject && selectedProject.target_languages.length > 1 && (
        <select
          className="project-picker-language"
          value={languageId ?? ""}
          onChange={(e) => onSelectLanguage(e.target.value)}
        >
          {selectedProject.target_languages.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
