import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/index.js';

describe('migration order and sequential comment numbers', () => {
  it('each element i of MIGRATIONS starts with comment // Migration i:', () => {
    const dbSourcePath = path.resolve(__dirname, '../src/db/index.ts');
    const sourceContent = fs.readFileSync(dbSourcePath, 'utf-8');
    const sourceFile = ts.createSourceFile('index.ts', sourceContent, ts.ScriptTarget.Latest, true);

    let migrationsNode: ts.ArrayLiteralExpression | null = null;
    function visit(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(sourceFile) === 'MIGRATIONS' &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        migrationsNode = node.initializer;
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    expect(migrationsNode).not.toBeNull();
    expect(migrationsNode!.elements.length).toBe(MIGRATIONS.length);

    migrationsNode!.elements.forEach((elem, i) => {
      const commentRanges = ts.getLeadingCommentRanges(sourceContent, elem.getFullStart());
      expect(commentRanges, `Expected element ${i} to have leading comments`).toBeDefined();
      expect(commentRanges!.length, `Expected element ${i} to have at least one comment`).toBeGreaterThan(0);

      const comment = sourceContent.slice(commentRanges![0].pos, commentRanges![0].end).trim();
      const expectedPrefix = `// Migration ${i}:`;
      expect(
        comment.startsWith(expectedPrefix),
        `Element ${i} of MIGRATIONS must start with comment "${expectedPrefix}", but found "${comment}"`,
      ).toBe(true);
    });
  });
});
