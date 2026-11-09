import { Image } from "expo-image";
import { Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { useMountEffect } from "@/lib/use-mount-effect";
import { createStyleHook } from "@/settings/theme-provider";

export function BrandLoadingView({
  animated = false,
  onAnimationComplete,
}: {
  animated?: boolean;
  onAnimationComplete?: () => void;
}) {
  const styles = useStyles();
  const reducedMotion = useReducedMotion();
  const shouldAnimate = animated && !reducedMotion;
  const opacity = useSharedValue(shouldAnimate ? 0 : 1);

  useMountEffect(() => {
    if (!shouldAnimate) {
      onAnimationComplete?.();
      return;
    }
    opacity.set(
      withTiming(1, { duration: 400 }, (finished) => {
        if (finished && onAnimationComplete) scheduleOnRN(onAnimationComplete);
      }),
    );
    return () => cancelAnimation(opacity);
  });

  const animationStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <View
      accessible
      accessibilityLabel="Loading Shots Founder Hub"
      accessibilityRole="progressbar"
      style={styles.container}
    >
      <Animated.View style={[styles.brand, animationStyle]}>
        <Image
          contentFit="contain"
          source={require("../../assets/images/splash-icon.png")}
          style={styles.mark}
        />
        <Text style={styles.name}>Shots Founder Hub</Text>
      </Animated.View>
    </View>
  );
}

const useStyles = createStyleHook((Colors) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.brandBackgroundTop,
  },
  brand: { alignItems: "center", gap: 16 },
  mark: { width: 100, height: 100, tintColor: Colors.ink },
  name: { fontSize: 24, fontWeight: "600", color: Colors.ink },
}));
