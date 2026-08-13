import { describe, expect, it } from 'vitest';
import { parseDotenv } from './load-env.js';

describe('parseDotenv', () => {
  it('parses plain assignments', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual([
      ['FOO', 'bar'],
      ['BAZ', 'qux'],
    ]);
  });

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# a comment\n\nFOO=bar\n   \n')).toEqual([['FOO', 'bar']]);
  });

  it('strips an inline comment from an unquoted value', () => {
    expect(parseDotenv('FOO=bar # trailing note')).toEqual([['FOO', 'bar']]);
  });

  it('keeps a hash inside a quoted value', () => {
    expect(parseDotenv('FOO="bar # not a comment"')).toEqual([['FOO', 'bar # not a comment']]);
  });

  it('unescapes newlines in double-quoted values, as the Firebase key needs', () => {
    expect(parseDotenv('KEY="line1\\nline2"')).toEqual([['KEY', 'line1\nline2']]);
  });

  it('leaves single-quoted values literal', () => {
    expect(parseDotenv("KEY='line1\\nline2'")).toEqual([['KEY', 'line1\\nline2']]);
  });

  it('keeps base64 padding and other = characters in the value', () => {
    expect(parseDotenv('K=YWJjZA==')).toEqual([['K', 'YWJjZA==']]);
  });

  it('ignores malformed keys and lines without an assignment', () => {
    expect(parseDotenv('not-a-line\n=novalue\n9BAD=x\nGOOD=y')).toEqual([['GOOD', 'y']]);
  });

  it('tolerates a URL containing a hash fragment when quoted', () => {
    expect(parseDotenv('U="https://a.test/p#frag"')).toEqual([['U', 'https://a.test/p#frag']]);
  });
});
