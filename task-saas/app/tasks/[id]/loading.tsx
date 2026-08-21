export default function TaskDetailLoading(): React.ReactElement {
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <div className="h-8 w-3/4 animate-pulse rounded bg-gray-200" />
        <div className="mt-4 h-4 w-full animate-pulse rounded bg-gray-200" />
        <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-gray-200" />
        <div className="mt-6 border-t pt-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="h-4 animate-pulse rounded bg-gray-200" />
            <div className="h-4 animate-pulse rounded bg-gray-200" />
          </div>
        </div>
      </div>
    </main>
  );
}
