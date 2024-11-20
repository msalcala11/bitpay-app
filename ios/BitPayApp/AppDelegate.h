#import <RCTAppDelegate.h>
@import BrazeUI;
@interface AppDelegate : RCTAppDelegate
@property (nonatomic, assign) BOOL isBitPayAppLoaded;
@property (nonatomic, strong) BRZInAppMessageRaw *cachedInAppMessage;
- (void)setBitPayAppLoaded:(BOOL)loaded;
@end
// #import <RCTAppDelegate.h>
// #import <BrazeKit/BrazeKit-Swift.h>

// @interface AppDelegate : RCTAppDelegate
// @property (nonatomic, assign) BOOL isBitPayAppLoaded;
// @property (nonatomic, strong) BRZInAppMessageRaw *cachedInAppMessage;
// - (void)setBitPayAppLoaded:(BOOL)loaded;
// @end


