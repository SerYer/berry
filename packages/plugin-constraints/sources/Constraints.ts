import {Ident, MessageName, Project, ReportError, Workspace}                                  from '@berry/core';
import {miscUtils, structUtils}                                                               from '@berry/core';
import {xfs, ppath, PortablePath, toFilename}                                                 from '@berry/fslib';
import pl                                                                                     from 'tau-prolog';

import {linkProjectToSession}                                                                 from './tauModule';

export const enum DependencyType {
  Dependencies = 'dependencies',
  DevDependencies = 'devDependencies',
  PeerDependencies = 'peerDependencies',
}

const DEPENDENCY_TYPES = [
  DependencyType.Dependencies,
  DependencyType.DevDependencies,
  DependencyType.PeerDependencies,
];

function extractErrorImpl(value: any): any {
  if (value instanceof pl.type.Num)
    return value.value;

  if (value instanceof pl.type.Term) {
    if (value.args.length === 0)
      return value.id;

    switch (value.indicator) {
      case `throw/1`:
        return extractErrorImpl(value.args[0]);
      case `error/1`:
        return extractErrorImpl(value.args[0]);
      case `error/2`:
        return Object.assign(extractErrorImpl(value.args[0]), ...extractErrorImpl(value.args[1]));
      case `syntax_error/1`:
        return new ReportError(MessageName.PROLOG_SYNTAX_ERROR, `Syntax error: ${extractErrorImpl(value.args[0])}`);
      case `existence_error/2`:
        return new ReportError(MessageName.PROLOG_EXISTENCE_ERROR, `Existence error: ${extractErrorImpl(value.args[0])} ${extractErrorImpl(value.args[1])} not found`)
      case `line/1`:
        return {line: extractErrorImpl(value.args[0])};
      case `column/1`:
        return {column: extractErrorImpl(value.args[0])};
      case `found/1`:
        return {found: extractErrorImpl(value.args[0])};
      case `./2`:
        return [extractErrorImpl(value.args[0])].concat(extractErrorImpl(value.args[1]));
      case `//2`:
        return `${extractErrorImpl(value.args[0])}/${extractErrorImpl(value.args[1])}`
    }
  }

  throw `couldn't pretty print because of unsupported node ${value}`;
}

function extractError(val: any) {
  let err;
  try {
    err = extractErrorImpl(val);
  } catch (caught) {
    if (typeof caught === `string`) {
      throw new ReportError(MessageName.PROLOG_UNKNOWN_ERROR, `Unknown error: ${val} (note: ${caught})`);
    } else {
      throw caught;
    }
  }

  if (typeof err.line !== `undefined` && typeof err.column !== `undefined`)
    err.message += ` at line ${err.line}, column ${err.column}`;

  return err;
}

// Node 8 doesn't have Symbol.asyncIterator
// https://github.com/Microsoft/TypeScript/issues/14151#issuecomment-280812617
if (Symbol.asyncIterator == null)
  (Symbol as any).asyncIterator = Symbol.for('Symbol.asyncIterator');

class Session {
  private readonly session: pl.type.Session;

  public constructor(project: Project, source: string) {
    this.session = pl.create();
    linkProjectToSession(this.session, project);

    this.session.consult(source);
  }

  private fetchNextAnswer() {
    return new Promise<pl.Answer>(resolve => {
      this.session.answer((result: any) => {
        resolve(result);
      });
    });
  }

  public async * makeQuery(query: string) {
    const parsed = this.session.query(query);

    if (parsed !== true)
      throw extractError(parsed);

    while (true) {
      const answer = await this.fetchNextAnswer();

      if (!answer)
        break;

      if (answer.id === `throw`)
        throw extractError(answer);

      yield answer;
    }
  }
}

function parseLink(link: pl.Link): string|null {
  if (link.id === `null`) {
    return null;
  } else {
    return `${link.toJavaScript()}`;
  }
}

export class Constraints {
  public readonly project: Project;

  public readonly source: string = ``;

  static async find(project: Project) {
    return new Constraints(project);
  }

  constructor(project: Project) {
    this.project = project;

    if (xfs.existsSync(ppath.join(project.cwd, toFilename(`constraints.pro`)))) {
      this.source = xfs.readFileSync(ppath.join(project.cwd, toFilename(`constraints.pro`)), `utf8`);
    }
  }

  getProjectDatabase() {
    let database = ``;

    for (const dependencyType of DEPENDENCY_TYPES)
      database += `dependency_type(${dependencyType}).\n`

    for (const workspace of this.project.workspacesByCwd.values()) {
      const relativeCwd = workspace.relativeCwd;

      database += `workspace(${escape(relativeCwd)}).\n`;
      database += `workspace_ident(${escape(relativeCwd)}, ${escape(structUtils.stringifyIdent(workspace.locator))}).\n`
      database += `workspace_version(${escape(relativeCwd)}, ${escape(workspace.manifest.version)}).\n`

      for (const dependencyType of DEPENDENCY_TYPES) {
        for (const dependency of workspace.manifest[dependencyType].values()) {
          database += `workspace_has_dependency(${escape(relativeCwd)}, ${escape(structUtils.stringifyIdent(dependency))}, ${escape(dependency.range)}, ${dependencyType}).\n`;
        }
      }
    }

    // Add default never matching predicates to prevent prolog instantiation errors
    // when constraints run in an empty workspace
    database += `workspace(_) :- false.\n`;
    database += `workspace_ident(_, _) :- false.\n`;
    database += `workspace_version(_, _) :- false.\n`;

    // Add a default never matching predicate to prevent prolog instantiation errors
    // when constraints run in a workspace without dependencies
    database += `workspace_has_dependency(_, _, _, _) :- false.\n`;

    return database;
  }

  getDeclarations() {
    let declarations = ``;

    // (Cwd, DependencyIdent, DependencyRange, DependencyType)
    declarations += `gen_enforced_dependency(_, _, _, _) :- false.\n`;

    // (Cwd, DependencyIdent, DependencyType, Reason)
    declarations += `gen_invalid_dependency(_, _, _, _) :- false.\n`;

    // (Cwd, Path, Value)
    declarations += `gen_enforced_field(_, _, _) :- false.\n`;

    return declarations;
  }

  get fullSource() {
    return `${this.getProjectDatabase()}\n${this.source}\n${this.getDeclarations()}`;
  }

  private createSession() {
    return new Session(this.project, this.fullSource);
  }

  async process() {
    const session = this.createSession();

    let enforcedDependencies: Array<{
      workspace: Workspace,
      dependencyIdent: Ident,
      dependencyRange: string | null,
      dependencyType: DependencyType,
    }> = [];

    for await (const answer of session.makeQuery(`workspace(WorkspaceCwd), dependency_type(DependencyType), gen_enforced_dependency(WorkspaceCwd, DependencyIdent, DependencyRange, DependencyType).`)) {
      const workspaceCwd = ppath.resolve(this.project.cwd, parseLink(answer.links.WorkspaceCwd) as PortablePath);
      const dependencyRawIdent = parseLink(answer.links.DependencyIdent);
      const dependencyRange = parseLink(answer.links.DependencyRange);
      const dependencyType = parseLink(answer.links.DependencyType) as DependencyType;

      if (workspaceCwd === null || dependencyRawIdent === null)
        throw new Error(`Invalid rule`);

      const workspace = this.project.getWorkspaceByCwd(workspaceCwd);
      const dependencyIdent = structUtils.parseIdent(dependencyRawIdent);

      enforcedDependencies.push({workspace, dependencyIdent, dependencyRange, dependencyType});
    }

    enforcedDependencies = miscUtils.sortMap(enforcedDependencies, [
      ({dependencyRange}) => dependencyRange !== null ? `0` : `1`,
      ({workspace}) => structUtils.stringifyIdent(workspace.locator),
      ({dependencyIdent}) => structUtils.stringifyIdent(dependencyIdent),
    ]);

    let invalidDependencies: Array<{
      workspace: Workspace,
      dependencyIdent: Ident,
      dependencyType: DependencyType,
      reason: string | null,
    }> = [];

    for await (const answer of session.makeQuery(`workspace(WorkspaceCwd), dependency_type(DependencyType), gen_invalid_dependency(WorkspaceCwd, DependencyIdent, DependencyType, Reason).`)) {
      const workspaceCwd = ppath.resolve(this.project.cwd, parseLink(answer.links.WorkspaceCwd) as PortablePath);
      const dependencyRawIdent = parseLink(answer.links.DependencyIdent);
      const dependencyType = parseLink(answer.links.DependencyType) as DependencyType;
      const reason = parseLink(answer.links.Reason);

      if (workspaceCwd === null || dependencyRawIdent === null)
        throw new Error(`Invalid rule`);

      const workspace = this.project.getWorkspaceByCwd(workspaceCwd);
      const dependencyIdent = structUtils.parseIdent(dependencyRawIdent);

      invalidDependencies.push({workspace, dependencyIdent, dependencyType, reason});
    }

    invalidDependencies = miscUtils.sortMap(invalidDependencies, [
      ({workspace}) => structUtils.stringifyIdent(workspace.locator),
      ({dependencyIdent}) => structUtils.stringifyIdent(dependencyIdent),
    ]);

    let enforcedFields: Array<{
      workspace: Workspace,
      fieldPath: string,
      fieldValue: string|null,
    }> = [];

    for await (const answer of session.makeQuery(`workspace(WorkspaceCwd), gen_enforced_field(WorkspaceCwd, FieldPath, FieldValue).`)) {
      const workspaceCwd = ppath.resolve(this.project.cwd, parseLink(answer.links.WorkspaceCwd) as PortablePath);
      const fieldPath = parseLink(answer.links.FieldPath);
      const fieldValue = parseLink(answer.links.FieldValue);

      if (workspaceCwd === null || fieldPath === null)
        throw new Error(`Invalid rule`);

      const workspace = this.project.getWorkspaceByCwd(workspaceCwd);

      enforcedFields.push({workspace, fieldPath, fieldValue});
    }

    enforcedFields = miscUtils.sortMap(enforcedFields, [
      ({workspace}) => structUtils.stringifyIdent(workspace.locator),
      ({fieldPath}) => fieldPath,
    ]);

    return {enforcedDependencies, invalidDependencies, enforcedFields};
  }

  async * query(query: string) {
    const session = this.createSession();

    for await (const answer of session.makeQuery(query)) {
      const parsedLinks: Record<string, string|null> = {};

      for (const [variable, value] of Object.entries(answer.links)) {
        if (variable !== `_`) {
          parsedLinks[variable] = parseLink(value);
        }
      }

      yield parsedLinks;
    }
  }
}

function escape(what: string | null) {
  if (typeof what === `string`) {
    return `'${what}'`;
  } else {
    return `[]`;
  }
}
