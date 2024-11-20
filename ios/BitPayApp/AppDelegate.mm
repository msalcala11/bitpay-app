#import "AppDelegate.h"
#import "../AllowedUrlPrefixProtocol.h"
#import "../SilentPushEvent.h"
#import <RNAppsFlyer.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTHTTPRequestHandler.h>
#import <React/RCTLinkingManager.h>
#import <React/RCTRootView.h>
#import "RNBootSplash.h"
#import "RNQuickActionManager.h"
#import <React/RCTLinkingManager.h>

// react-native-keyevent
#import <RNKeyEvent.h>

// Braze SDK
// #import <UserNotifications/UserNotifications.h>
// #import <BrazeKit/BrazeKit-Swift.h>
// #import "BrazeReactBridge.h"
#import <UserNotifications/UserNotifications.h>
#import <BrazeKit/BrazeKit-Swift.h>
#import "BrazeReactBridge.h"
@import BrazeUI;

@interface AppDelegate () <BRZInAppMessageUIDelegate>
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  self.moduleName = @"BitPay";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};

  [super application:application didFinishLaunchingWithOptions:launchOptions];
  
  [ RNBootSplash initWithStoryboard:@"BootSplash" rootView:self.window.rootViewController.view]; // <- initialization using the storyboard file name

  // Setup Braze
  BRZConfiguration *configuration = [[BRZConfiguration alloc] initWithApiKey:@"BRAZE_API_KEY_REPLACE_ME" endpoint:@"sdk.iad-05.braze.com"];
  configuration.logger.level = BRZLoggerLevelInfo;
  configuration.triggerMinimumTimeInterval = 1;

  Braze *braze = [BrazeReactBridge initBraze:configuration];
  AppDelegate.braze = braze;
  
  // Initialize Braze UI
  BRZInAppMessageUI *inAppMessageUI = [[BRZInAppMessageUI alloc] init];
  inAppMessageUI.delegate = self;
  braze.inAppMessagePresenter = inAppMessageUI;
  
  self.isBitPayAppLoaded = NO;
  self.cachedInAppMessage = nil;

  RCTSetCustomNSURLSessionConfigurationProvider(^NSURLSessionConfiguration *{
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    NSMutableArray *urlProtocolClasses = [NSMutableArray arrayWithArray:configuration.protocolClasses];
    Class allowedUrlPrefixProtocol = AllowedUrlPrefixProtocol.class;
    [urlProtocolClasses insertObject:allowedUrlPrefixProtocol atIndex:0];
    configuration.protocolClasses = urlProtocolClasses;
    return configuration;
  });

  return YES;
}

- (void)application:(UIApplication *)application performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem completionHandler:(void (^)(BOOL succeeded)) completionHandler {
  [RNQuickActionManager onQuickActionPress:shortcutItem completionHandler:completionHandler];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}
 
- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
  return true;
}

// Deep linking
// Open URI-scheme for iOS 9 and above
- (BOOL)application:(UIApplication *)application
  openURL:(NSURL *)url
  options:(NSDictionary *)options
{
  [RCTLinkingManager application:application openURL:url options:options];
  [[AppsFlyerAttribution shared] handleOpenUrl:url options:options];
  return YES;
}

// Open URI-scheme for iOS 8 and below
- (BOOL)application:(UIApplication *)application
  openURL:(NSURL *)url
  sourceApplication:(NSString*)sourceApplication
  annotation:(id)annotation {
  [RCTLinkingManager application:application openURL:url
                        sourceApplication:sourceApplication annotation:annotation];
  [[AppsFlyerAttribution shared] handleOpenUrl:url sourceApplication:sourceApplication annotation:annotation];
  return YES;
}

// Open Universal Links
- (BOOL)application:(UIApplication *)application
  continueUserActivity:(NSUserActivity *)userActivity
  restorationHandler:(void (^)(NSArray * _Nullable))restorationHandler {
  [RCTLinkingManager application:application
                     continueUserActivity:userActivity
                       restorationHandler:restorationHandler];
  [[AppsFlyerAttribution shared] continueUserActivity:userActivity restorationHandler:restorationHandler];
  return YES;
}

// react-native-keyevent
- (NSMutableArray<UIKeyCommand *> *)keyCommands {
  NSMutableArray *keys = [NSMutableArray new];
  
  if (keyEvent == nil) {
    keyEvent = [[RNKeyEvent alloc] init];
  }
  
  if (self.bridge) {
    [keyEvent setRCTBridge:self.bridge];
  }
  
  UIKeyCommand *upArrow = [UIKeyCommand keyCommandWithInput: UIKeyInputUpArrow
                                           modifierFlags: 0
                                           action: @selector(keyInput:)];
  
  UIKeyCommand *downArrow = [UIKeyCommand keyCommandWithInput: UIKeyInputDownArrow
                                             modifierFlags: 0
                                             action: @selector(keyInput:)];
  
  [keys addObject: upArrow];
  [keys addObject: downArrow];
  
  return keys;
}

- (void)keyInput:(UIKeyCommand *)sender {
  NSString *selected = sender.input;
  
  if (keyEvent != nil) {
    [keyEvent sendKeyEvent:selected];
  }
}

// Braze
- (void)before:(BRZInAppMessageUI *)ui willPresent:(id<BRZInAppMessage>)message {
  if (!self.isBitPayAppLoaded) {
    self.cachedInAppMessage = message;
    return;
  }
  
  SilentPushEvent *event = [[SilentPushEvent alloc] init];
  [event sendEventWithName:@"onBeforeInAppMessageDisplayed" body:@{@"message": @"Braze in-app message will be displayed"}];
}

- (void)after:(BRZInAppMessageUI *)ui didPresent:(id<BRZInAppMessage>)message {
  SilentPushEvent *event = [[SilentPushEvent alloc] init];
  [event sendEventWithName:@"onAfterInAppMessageDisplayed" body:@{@"message": @"Braze in-app message was displayed"}];
}

- (void)setBitPayAppLoaded {
  self.isBitPayAppLoaded = YES;
  
  if (self.cachedInAppMessage != nil) {
    [AppDelegate.braze.inAppMessagePresenter presentMessage:self.cachedInAppMessage];
    self.cachedInAppMessage = nil;
  }
}

@end
