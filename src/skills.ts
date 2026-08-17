/**
 * Static skills: markdown files from the repo's skills/ directory, loaded
 * once at module load and appended to the chat agent's system prompt.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

function loadSkills(): string[] {
  const dir = process.env.SKILLS_DIR ?? '/app/skills';
  const dirs = [dir, join(process.cwd(), 'skills')];
  for (const d of dirs) {
    try {
      const files = readdirSync(d)
        .filter((f) => f.endsWith('.md'))
        .sort();
      if (files.length === 0) continue;
      return files.map(
        (f) => `[Skill: ${f.replace(/\.md$/, '')}]\n${readFileSync(join(d, f), 'utf8').trim()}`,
      );
    } catch {
      // directory missing — try the next candidate
    }
  }
  return [];
}

/** Skill texts to append to the system prompt (possibly empty). */
export const SKILLS: string[] = loadSkills();
