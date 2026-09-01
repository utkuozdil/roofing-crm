/**
 * The natural-language query panel.
 *
 * It drives the app rather than answering beside it. A question is translated by the API
 * into the same `{ center, radiusMiles, filters, sort }` the search controls produce, that
 * query is pushed into the map view's own state through {@link RagChatMountProps.onApplyQuery},
 * and the map, the filter inputs, and the results list all update from it. This panel keeps
 * no rows of its own, so there is no second result set that can disagree with the first.
 *
 * What it does render is the **interpretation**: the criteria that were applied, in plain
 * language, with the match count the API measured by running the same query through the same
 * data source. That is the part that makes the answer auditable — a salesperson can see that
 * "34 matches" is the size of a stated filter set, and can then adjust any one of those
 * filters on the panel to the left.
 *
 * Three states are not the happy path and all three are real UI:
 *   - no model configured, which the API reports before the operator types;
 *   - a question the engine will not answer, which returns what it *can* do;
 *   - a model call that failed, which says so and leaves the manual filters working.
 */

import {
  type GeoPoint,
  type PropertyFilters,
  type RetrievedOpportunity,
  type SearchSort,
  NLQ_EXAMPLE_QUESTIONS,
  MAX_QUESTION_LENGTH,
} from '@roofing-crm/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { formatCoordinates } from '../format';

/** The query shape the panel hands back to the map view. Mirrors `nlq.ask`'s `query`. */
export interface NlqAppliedQuery {
  center: GeoPoint;
  centerLabel: string;
  radiusMiles: number;
  filters: PropertyFilters;
  sort: SearchSort;
}

interface Criterion {
  key: string;
  label: string;
}

interface AnsweredState {
  kind: 'answered';
  question: string;
  answer: string;
  summary: string;
  criteria: Criterion[];
  notes: string[];
  matched: number;
  inRadius: number;
  evidence: RetrievedOpportunity[];
  citedParcelIds: string[];
  query: NlqAppliedQuery;
}

interface MessageState {
  /** `refused` is the operator's fault-free "I can't answer that"; the others are ours. */
  kind: 'refused' | 'unavailable' | 'error';
  question: string;
  message: string;
  capabilities: string[];
}

type ChatState = AnsweredState | MessageState | null;

type ConfigState =
  | { kind: 'loading' }
  | { kind: 'ready'; modelId: string | null }
  | { kind: 'disabled'; message: string }
  | { kind: 'unreachable'; message: string };

export interface RagChatMountProps {
  center: GeoPoint;
  radiusMiles: number;
  filters: PropertyFilters;
  resultCount: number;
  onApplyQuery: (query: NlqAppliedQuery) => void;
}

const STATUS_LABELS = {
  loading: 'Checking…',
  ready: 'Ready',
  disabled: 'Unavailable',
  unreachable: 'Unavailable',
  asking: 'Retrieving…',
} as const;

export function RagChatMount({
  center,
  radiusMiles,
  filters,
  resultCount,
  onApplyQuery,
}: RagChatMountProps) {
  const [config, setConfig] = useState<ConfigState>({ kind: 'loading' });
  const [question, setQuestion] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  const [state, setState] = useState<ChatState>(null);

  /** Guards against a slow first answer overwriting a faster second one. */
  const askSequence = useRef(0);

  /**
   * Availability is settled before the operator types, so the disabled state is a rendered
   * panel with worked examples rather than a failure discovered on submit.
   */
  useEffect(() => {
    let cancelled = false;
    api.nlq.config
      .query()
      .then((response) => {
        if (cancelled) return;
        setConfig(
          response.enabled
            ? { kind: 'ready', modelId: response.modelId }
            : {
                kind: 'disabled',
                message: response.message ?? 'Natural-language search is not configured.',
              },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setConfig({
          kind: 'unreachable',
          message:
            'Could not reach the API to check whether natural-language search is available. The filters on the left are unaffected.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const isEnabled = config.kind === 'ready';

  const ask = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === '' || !isEnabled || isAsking) return;

      const sequence = askSequence.current + 1;
      askSequence.current = sequence;
      setIsAsking(true);

      try {
        const response = await api.nlq.ask.mutate({
          question: trimmed,
          center,
          radiusMiles,
        });
        if (askSequence.current !== sequence) return;

        if (response.status === 'answered') {
          setState({
            kind: 'answered',
            question: response.question,
            answer: response.answer,
            summary: response.summary,
            criteria: [...response.criteria],
            notes: [...response.notes],
            matched: response.counts.matched,
            inRadius: response.counts.inRadius,
            evidence: [...response.evidence],
            citedParcelIds: [...response.citedParcelIds],
            query: response.query,
          });
          // The whole point: the question moves the app, it does not answer beside it.
          onApplyQuery(response.query);
          return;
        }

        setState({
          kind: response.status,
          question: response.question,
          message: response.message,
          capabilities: [...response.capabilities],
        });
      } catch (error: unknown) {
        if (askSequence.current !== sequence) return;
        setState({
          kind: 'error',
          question: trimmed,
          message: `The question could not be sent: ${
            error instanceof Error ? error.message : String(error)
          }. The filters on the left still work.`,
          capabilities: [],
        });
      } finally {
        if (askSequence.current === sequence) setIsAsking(false);
      }
    },
    [center, radiusMiles, isEnabled, isAsking, onApplyQuery],
  );

  const statusKind = isAsking ? 'asking' : config.kind;

  return (
    <section
      className="panel rag-panel rag-panel--bar"
      data-testid="rag-chat-mount"
      data-enabled={isEnabled ? 'true' : 'false'}
      aria-labelledby="rag-heading"
    >
      <header className="rag-head">
        <h2 id="rag-heading">Ask the RAG agent</h2>
        <span
          className={`pill ${isEnabled ? 'pill--ok' : 'pill--warn'}${statusKind === 'ready' ? ' visually-hidden' : ''}`}
          data-testid="rag-status"
          data-state={statusKind}
        >
          {STATUS_LABELS[statusKind]}
        </span>
      </header>

      <form
        className="rag-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <label className="field" htmlFor="rag-chat-input">
          <span className="visually-hidden">Question</span>
          <textarea
            id="rag-chat-input"
            data-testid="rag-chat-input"
            name="ragQuestion"
            rows={1}
            maxLength={MAX_QUESTION_LENGTH}
            disabled={!isEnabled}
            aria-disabled={!isEnabled}
            aria-describedby="rag-examples-heading"
            placeholder="Houses near Lake Mary with roofs over 20 years old"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              // Enter asks; Shift+Enter is a newline. A headless driver can do either.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void ask(question);
              }
            }}
          />
        </label>

        <button
          className="button button--primary"
          type="submit"
          data-testid="rag-chat-send"
          disabled={!isEnabled || isAsking || question.trim() === ''}
          aria-disabled={!isEnabled || isAsking || question.trim() === ''}
        >
          {isAsking ? 'Retrieving…' : 'Ask'}
        </button>
      </form>

      {/*
        Examples are the disabled state's whole content, so they are always rendered rather
        than being a hint that disappears when the feature is off.
      */}
      <div className="rag-examples">
        <p className="rag-examples-heading" id="rag-examples-heading">
          Example questions
        </p>
        <ul data-testid="rag-examples">
          {NLQ_EXAMPLE_QUESTIONS.map((example, index) => (
            <li key={example}>
              <button
                className="link-button"
                type="button"
                data-testid={`rag-example-${index}`}
                disabled={!isEnabled || isAsking}
                onClick={() => {
                  setQuestion(example);
                  void ask(example);
                }}
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {config.kind === 'disabled' && (
        <p className="note note--warn" data-testid="rag-unavailable" role="status">
          {config.message}
        </p>
      )}

      {config.kind === 'unreachable' && (
        <p className="note note--bad" data-testid="rag-unavailable" role="status">
          {config.message}
        </p>
      )}

      {state?.kind === 'answered' && (
        <div
          className="rag-answer"
          data-testid="rag-interpretation"
          role="status"
          data-matched={state.matched}
          data-in-radius={state.inRadius}
          data-center-label={state.query.centerLabel}
          data-radius-miles={state.query.radiusMiles}
          data-roof-age={state.query.filters.minRoofAgeYears}
          data-unknown-roof-age={String(state.query.filters.includeUnknownRoofAge)}
          data-permit-status={state.query.filters.permitStatus}
          data-out-of-area={String(state.query.filters.outOfAreaOwnerOnly)}
          data-pool={state.query.filters.poolStatus}
          data-sold-since={state.query.filters.soldSinceYear}
          data-min-just-value={state.query.filters.minJustValue}
          data-years-since-sale={state.query.filters.minYearsSinceLastSale}
          data-sort={state.query.sort}
        >
          <p className="rag-answer-text" data-testid="rag-answer">
            {state.answer}
          </p>

          {state.citedParcelIds.length > 0 && (
            <ol className="rag-citations" data-testid="rag-citations">
              {state.citedParcelIds.map((parcelId) => {
                const card = state.evidence.find((item) => item.parcel_id === parcelId);
                if (!card) return null;
                return (
                  <li
                    key={parcelId}
                    data-testid="rag-citation"
                    data-parcel-id={parcelId}
                  >
                    <span>{card.address}</span>
                    {card.roof_age_years !== null && (
                      <span className="muted"> · roof {card.roof_age_years}y</span>
                    )}
                    {card.unresolved_roofing > 0 && (
                      <span className="muted"> · {card.unresolved_roofing} open roofing</span>
                    )}
                    {card.contractor_name && (
                      <span className="muted">
                        {' '}
                        · {card.contractor_name}
                        {card.bbb_rating ? ` BBB ${card.bbb_rating}` : ''}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          <p className="rag-summary" data-testid="rag-summary">
            {state.summary}
          </p>

          <ul className="rag-criteria visually-hidden" data-testid="rag-criteria">
            {state.criteria.map((criterion) => (
              <li
                key={criterion.key}
                className="pill"
                data-testid="rag-criterion"
                data-criterion-key={criterion.key}
              >
                {criterion.label}
              </li>
            ))}
          </ul>

          <p className="visually-hidden" data-testid="rag-applied">
            Applied to the map, the search panel, and the candidate list.
          </p>

          {/*
            Caveats are part of the answer, not a footnote: a roof-age question silently drops
            the ~10% of parcels with no building, and a count is not trustworthy until that is
            said out loud.
          */}
          {state.notes.length > 0 && (
            <ul className="rag-notes" data-testid="rag-notes">
              {state.notes.map((note) => (
                <li key={note} className="note note--warn" data-testid="rag-note">
                  {note}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state?.kind === 'refused' && (
        <div className="rag-answer" data-testid="rag-refusal" role="alert">
          <p className="note note--bad" data-testid="rag-refusal-message">
            {state.message}
          </p>
          {/*
            The reason itself comes from whichever layer refused — the model for an off-topic
            question, the gazetteer for an out-of-county place — so the scope is stated here
            rather than left to the wording of either. A refusal that does not say what the
            system does cover is only half an answer.
          */}
          <p className="note" data-testid="rag-refusal-scope">
            This CRM holds parcel and permit records for Seminole County, FL only. Here is what I
            can filter on:
          </p>
          <ul className="rag-notes" data-testid="rag-capabilities">
            {state.capabilities.map((capability) => (
              <li key={capability} className="note">
                {capability}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(state?.kind === 'error' || state?.kind === 'unavailable') && (
        <p className="note note--bad" data-testid="rag-error" role="alert">
          {state.message}
        </p>
      )}

      <p className="visually-hidden" data-testid="rag-context-preview">
        Map context sent with each question — centre{' '}
        {formatCoordinates(center.latitude, center.longitude)}, radius {radiusMiles} mi, roof age ≥{' '}
        {filters.minRoofAgeYears} y, permits {filters.permitStatus}, {resultCount} properties
        currently in scope.
        {config.kind === 'ready' && config.modelId ? ` Model ${config.modelId}.` : ''}
      </p>
    </section>
  );
}
