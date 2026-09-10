import type { Goal } from '../types';

interface Props {
  goal: Goal;
  onClick: () => void;
}

function formatDatetime(iso: string): string {
  return new Date(iso).toLocaleString('en-SG', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Singapore',
  });
}

export default function GoalCard({ goal, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-slate-900 border border-slate-800 rounded-xl px-5 py-4
                 hover:border-violet-500/50 hover:bg-slate-900/80 transition-all duration-200
                 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2
                 focus:ring-offset-slate-950 group"
    >
      {/* Top row: date left, model + arrow right */}
      <div className="flex items-center justify-between gap-4 mb-3">
        <span className="text-xs text-slate-500">{formatDatetime(goal.datetime_inserted)}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                       bg-violet-500/15 text-violet-300 border border-violet-500/25"
          >
            {goal.model_name}
          </span>
          {goal.task_title && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-800 border border-slate-700 rounded-full px-2.5 py-0.5 max-w-[180px]">
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
              </svg>
              <span className="truncate">{goal.task_title}</span>
            </span>
          )}
          <svg
            className="w-4 h-4 text-slate-600 group-hover:text-violet-400 transition-colors shrink-0"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
        </div>
      </div>

      {/* Goal text */}
      <p className="text-slate-100 text-sm leading-relaxed line-clamp-2 group-hover:text-white transition-colors mb-2">
        {goal.goal}
      </p>

      {/* Output preview + attachments */}
      <div className="flex items-end justify-between gap-4">
        {goal.output ? (
          <p className="text-xs text-slate-500 line-clamp-1 leading-relaxed flex-1 font-mono">
            {goal.output}
          </p>
        ) : (
          <span />
        )}
        {goal.attachments && goal.attachments.length > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-slate-500 shrink-0">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
            </svg>
            {goal.attachments.length}
          </span>
        )}
      </div>
    </button>
  );
}
