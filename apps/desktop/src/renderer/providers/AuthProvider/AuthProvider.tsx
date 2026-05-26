import {
	type ReactNode,
	useEffect,
	useEffectEvent,
	useRef,
	useState,
} from "react";
import {
	authClient,
	getAuthToken,
	setAuthToken,
	setJwt,
} from "renderer/lib/auth-client";
import { SupersetLogo } from "renderer/routes/sign-in/components/SupersetLogo/SupersetLogo";
import { electronTrpc } from "../../lib/electron-trpc";

export function AuthProvider({ children }: { children: ReactNode }) {
	const [isHydrated, setIsHydrated] = useState(false);
	const activeTokenRef = useRef<string | null>(null);
	const hydrationStartedRef = useRef(false);
	const sessionRefetchInFlightRef = useRef(false);
	const tokenChangeInFlightRef = useRef(false);
	const { refetch: refetchSession } = authClient.useSession();

	const { data: storedToken, isSuccess } =
		electronTrpc.auth.getStoredToken.useQuery(undefined, {
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		});

	const refetchSessionSafely = useEffectEvent(async (context: string) => {
		if (sessionRefetchInFlightRef.current) return;

		sessionRefetchInFlightRef.current = true;
		try {
			await refetchSession({
				query: { disableCookieCache: true, disableRefresh: true },
			});
		} catch (err) {
			console.warn(`[AuthProvider] session refetch failed ${context}`, err);
		} finally {
			sessionRefetchInFlightRef.current = false;
		}
	});

	const hydrateAuth = useEffectEvent(async () => {
		if (storedToken?.token && storedToken?.expiresAt) {
			const isExpired = new Date(storedToken.expiresAt) < new Date();
			if (!isExpired) {
				activeTokenRef.current = storedToken.token;
				setAuthToken(storedToken.token);
				await refetchSessionSafely("during hydration");
				try {
					const res = await authClient.token();
					if (res.data?.token) {
						setJwt(res.data.token);
					}
				} catch (err) {
					console.warn("[AuthProvider] JWT fetch failed during hydration", err);
				}
			}
		}
	});

	useEffect(() => {
		if (!isSuccess || isHydrated || hydrationStartedRef.current) return;

		let cancelled = false;
		hydrationStartedRef.current = true;

		hydrateAuth().finally(() => {
			if (!cancelled) {
				setIsHydrated(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [isSuccess, isHydrated]);

	const handleTokenChanged = useEffectEvent(
		async (data: { token: string; expiresAt: string } | null) => {
			if (tokenChangeInFlightRef.current) return;

			tokenChangeInFlightRef.current = true;
			try {
				if (data?.token && data?.expiresAt) {
					if (activeTokenRef.current === data.token) {
						setIsHydrated(true);
						return;
					}

					activeTokenRef.current = data.token;
					setAuthToken(data.token);
					await refetchSessionSafely("after token change");
					setIsHydrated(true);
				} else if (data === null) {
					activeTokenRef.current = null;
					setAuthToken(null);
					setJwt(null);
					await refetchSessionSafely("after token cleared");
				}
			} finally {
				tokenChangeInFlightRef.current = false;
			}
		},
	);

	electronTrpc.auth.onTokenChanged.useSubscription(undefined, {
		onData: (data) => {
			void handleTokenChanged(data);
		},
	});

	useEffect(() => {
		if (!isHydrated) return;

		const refreshJwt = () => {
			if (!getAuthToken()) {
				setJwt(null);
				return;
			}

			authClient
				.token()
				.then((res) => {
					if (res.data?.token) {
						setJwt(res.data.token);
					}
				})
				.catch((err: unknown) => {
					console.warn("[AuthProvider] JWT refresh failed", err);
				});
		};

		refreshJwt();
		const interval = setInterval(refreshJwt, 50 * 60 * 1000);
		return () => clearInterval(interval);
	}, [isHydrated]);

	if (!isHydrated) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-background">
				<SupersetLogo className="h-8 w-auto" gradient />
			</div>
		);
	}

	return <>{children}</>;
}
