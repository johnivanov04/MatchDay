'use client';

import { useActionState, useState } from 'react';
import { ActionTray, TrayButton } from '@/components/ui/button';
import { FormError, inputClassName, SubmitButton } from '@/components/ui/field';
import { PlayerAvatar } from '@/components/ui/player-avatar';
import {
  assignPlayerAction,
  createTeamAction,
  deleteTeamAction,
  publishTeamsAction,
  randomizeTeamsAction,
  renameTeamAction,
} from '@/server/actions/teams';
import type { DraftTeam, TeamBuilderPlayer } from '@/types/database';
import { pluralize } from '@/lib/format/plural';

/**
 * The administrator's team builder.
 *
 * Assignment is a select per player rather than drag-and-drop. A pickup-league
 * administrator does this on a phone at the side of a pitch, where dragging is
 * awkward and a dropdown is not — and it avoids pulling in a drag library for
 * an interaction that a native control already handles accessibly.
 *
 * Everything here is a draft. Nothing on this screen is visible to a player
 * until *Publish teams* is pressed, which is why the publication control states
 * what it will do rather than sitting quietly among the others.
 */

function fullName(player: { first_name: string; last_name: string }): string {
  return `${player.first_name} ${player.last_name}`.trim();
}

/**
 * The indicators 02 §11 permits while choosing teams.
 *
 * Context for a human decision, and nothing more. There is deliberately no
 * rating, score, ranking or attendance figure: the MVP has no skill field and
 * nothing here infers one from positions, gender or history.
 */
function indicatorsFor(player: TeamBuilderPlayer): string[] {
  return [
    player.goalkeeper_willing === true ? 'Goalkeeper' : null,
    player.preferred_positions.length > 0 ? player.preferred_positions.join(', ') : null,
    player.gender,
  ].filter((value): value is string => value !== null && value !== '');
}

function PlayerRow({
  player,
  teams,
  leagueId,
  matchId,
}: {
  player: TeamBuilderPlayer;
  teams: DraftTeam[];
  leagueId: string;
  matchId: string;
}) {
  const [state, submit, pending] = useActionState(assignPlayerAction, null);
  const indicators = indicatorsFor(player);

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <PlayerAvatar player={player} size={32} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{fullName(player)}</p>
          {indicators.length === 0 ? null : (
            <p className="truncate text-xs text-muted">{indicators.join(' · ')}</p>
          )}
        </div>
      </div>

      {/* `flex-1` with a floor rather than `min-w-36` on the select: at 320px
          the fixed 144px select left the Save button about 30px, which wrapped
          the word onto two lines as "Sa / ve". The select now gives way and the
          button keeps its text on one line. */}
      <form action={submit} className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="match_id" value={matchId} />
        <input type="hidden" name="membership_id" value={player.membership_id} />

        <label className="sr-only" htmlFor={`team-${player.membership_id}`}>
          Team for {fullName(player)}
        </label>
        <select
          id={`team-${player.membership_id}`}
          name="team_id"
          defaultValue={player.team_id ?? ''}
          className={`${inputClassName} min-w-0 flex-1 sm:w-36 sm:flex-none`}
        >
          <option value="">Unassigned</option>
          {teams.map((team) => (
            <option key={team.team_id} value={team.team_id}>
              {team.name}
            </option>
          ))}
        </select>

        {/* Quiet, and deliberately quieter than it was. This fires once per
            player while teams are being sorted out; "Publish teams" fires once
            and is the only thing on the screen a player ever sees the result
            of. A bordered button on every row was competing with it. */}
        <TrayButton
          type="submit"
          disabled={pending}
          className="shrink-0 border border-[var(--border-subtle)]"
          title={state?.ok === false ? state.message : undefined}
        >
          {pending ? '…' : 'Save'}
        </TrayButton>
      </form>
    </li>
  );
}

function TeamCard({
  team,
  players,
  leagueId,
}: {
  team: DraftTeam;
  players: TeamBuilderPlayer[];
  leagueId: string;
}) {
  const [renameState, rename, renaming] = useActionState(renameTeamAction, null);
  const [deleteState, remove, removing] = useActionState(deleteTeamAction, null);
  const [editing, setEditing] = useState(false);

  const members = players.filter((player) => player.team_id === team.team_id);

  return (
    // `min-w-0` is load-bearing, not tidiness. A grid item defaults to
    // `min-width: auto`, so it refuses to shrink below its content's
    // min-content width — and the truncating player names inside are
    // `white-space: nowrap`, whose min-content width is the *whole* name.
    // Without this the track grows to fit the longest name in the squad and
    // takes the document sideways with it at 320px.
    <section className="surface-card flex min-w-0 flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            {team.name} <span className="text-muted">({members.length})</span>
          </h3>
          {team.label === null ? null : <p className="text-xs text-muted">{team.label}</p>}
        </div>
        <ActionTray>
          <TrayButton
            onClick={() => setEditing((value) => !value)}
            aria-expanded={editing}
            aria-controls={`rename-${team.team_id}`}
          >
            Rename
          </TrayButton>
          <form action={remove} className="inline">
            <input type="hidden" name="league_id" value={leagueId} />
            <input type="hidden" name="team_id" value={team.team_id} />
            <TrayButton type="submit" disabled={removing}>
              {removing ? '…' : 'Delete'}
            </TrayButton>
          </form>
        </ActionTray>
      </div>

      <FormError
        message={
          renameState?.ok === false
            ? renameState.message
            : deleteState?.ok === false
              ? deleteState.message
              : undefined
        }
      />

      {editing ? (
        <form id={`rename-${team.team_id}`} action={rename} className="flex flex-col gap-2">
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="team_id" value={team.team_id} />
          <label className="sr-only" htmlFor={`name-${team.team_id}`}>
            Team name
          </label>
          <input
            id={`name-${team.team_id}`}
            name="name"
            defaultValue={team.name}
            maxLength={60}
            required
            className={inputClassName}
          />
          <label className="sr-only" htmlFor={`label-${team.team_id}`}>
            Shirt or colour
          </label>
          <input
            id={`label-${team.team_id}`}
            name="label"
            defaultValue={team.label ?? ''}
            maxLength={40}
            placeholder="Shirt or colour, e.g. Bibs"
            className={inputClassName}
          />
          <SubmitButton pending={renaming} variant="secondary">
            Save team
          </SubmitButton>
        </form>
      ) : null}

      {members.length === 0 ? (
        <p className="text-sm text-muted">Nobody on this team yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {members.map((player) => (
            <li key={player.membership_id} className="flex items-center gap-2 text-sm">
              {/* 24px in the dense per-team lists, matching the published team
                  sheet a player sees — the same information at the same weight. */}
              <PlayerAvatar player={player} size={24} />
              <span className="min-w-0 truncate">{fullName(player)}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Deleting a team leaves its players unassigned rather than moving them. */}
      {members.length > 0 ? (
        <p className="text-xs text-muted">
          Deleting this team leaves these players unassigned.
        </p>
      ) : null}
    </section>
  );
}

export function TeamBuilder({
  leagueId,
  matchId,
  teams,
  players,
  teamRevision,
  publishedAt,
}: {
  leagueId: string;
  matchId: string;
  teams: DraftTeam[];
  players: TeamBuilderPlayer[];
  teamRevision: number;
  publishedAt: string | null;
}) {
  const [createState, create, creating] = useActionState(createTeamAction, null);
  const [randomState, randomize, randomizing] = useActionState(randomizeTeamsAction, null);
  const [publishState, publish, publishing] = useActionState(publishTeamsAction, null);

  const unassigned = players.filter((player) => player.team_id === null);
  const published = publishedAt !== null;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {players.length} confirmed · {unassigned.length} unassigned ·{' '}
        {pluralize(teams.length, 'team')}
        {published ? ` · published revision ${String(teamRevision)}` : ' · not published'}
      </p>

      <div className="flex flex-wrap gap-2">
        <form action={create}>
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="match_id" value={matchId} />
          <SubmitButton pending={creating} variant="secondary">
            Add a team
          </SubmitButton>
        </form>

        <form action={randomize}>
          <input type="hidden" name="league_id" value={leagueId} />
          <input type="hidden" name="match_id" value={matchId} />
          <SubmitButton pending={randomizing} variant="secondary">
            Randomize teams
          </SubmitButton>
        </form>
      </div>

      {/*
        Says what the shuffle does and does not do. 04 §3 settled that
        randomization is equal-size only and must not be presented as balanced —
        the product has no skill rating and nothing here invents one.
      */}
      <p className="text-xs text-muted">
        Randomizing splits the confirmed players evenly by count. It does not consider
        position, goalkeeper willingness, gender or ability — adjust the teams yourself
        afterwards.
      </p>

      <FormError
        message={
          createState?.ok === false
            ? createState.message
            : randomState?.ok === false
              ? randomState.message
              : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {teams.map((team) => (
          <TeamCard key={team.team_id} team={team} players={players} leagueId={leagueId} />
        ))}
      </div>

      <section className="surface-card flex flex-col gap-2 p-4">
        <h3 className="text-sm font-semibold">
          Confirmed players <span className="text-muted">({players.length})</span>
        </h3>
        {unassigned.length > 0 ? (
          <p className="text-sm text-flag-700 dark:text-flag-200">
            {pluralize(unassigned.length, 'player')}{' '}
            {unassigned.length === 1 ? 'still needs' : 'still need'} a team before you can
            publish.
          </p>
        ) : null}
        {players.length === 0 ? (
          <p className="text-sm text-muted">Nobody is confirmed for this match yet.</p>
        ) : (
          <ul>
            {players.map((player) => (
              <PlayerRow
                key={player.membership_id}
                player={player}
                teams={teams}
                leagueId={leagueId}
                matchId={matchId}
              />
            ))}
          </ul>
        )}
      </section>

      <form action={publish} className="surface-card flex flex-col gap-3 p-4">
        <h3 className="text-sm font-semibold">
          {published ? 'Publish updated teams' : 'Publish teams'}
        </h3>
        <FormError message={publishState?.ok === false ? publishState.message : undefined} />
        {publishState?.ok === true ? (
          <p role="status" className="text-sm font-medium text-pitch-600">
            Teams published.
          </p>
        ) : null}

        <p className="text-sm text-muted">
          {published
            ? `Players are still seeing revision ${String(teamRevision)}. Publishing shows them your current teams and tells them they changed.`
            : 'Nothing above is visible to players yet. Publishing shows them the teams and tells them once.'}
        </p>

        <input type="hidden" name="league_id" value={leagueId} />
        <input type="hidden" name="match_id" value={matchId} />
        <SubmitButton pending={publishing}>
          {published ? 'Publish updated teams' : 'Publish teams'}
        </SubmitButton>
      </form>
    </div>
  );
}
